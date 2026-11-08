// sincronização entre aparelhos com CRDT (LWW-Map por campo + HLC + lápides), cifrada de ponta a ponta.
// Teste de integração do CRDT: dois ou três aparelhos, cada um com o seu banco, editam offline e
// sincronizam em ordens diferentes por um servidor em memória que segue o mesmo contrato do backend (push com
// baseSeq e conflito, pull incremental por `since`). Confirma que nada se perde e que todos convergem.
import { VaultDatabase, Collection } from '../db/Database';
import { newCredential, newFolder } from '../services/Repository';
import { CredentialVersion } from '../types/models';
import { uuid } from '../crypto';
import {
  decodePairingCode,
  decryptSyncDoc,
  deriveSyncAccount,
  encodePairingCode,
  encryptSyncDoc,
  generateSyncKey,
  normalizePairingCode,
  PAIRING_CODE_CHARS,
} from '../crypto/sync';
import { DocState, HybridClock, MAX_DRIFT_MS, captureLocal, isAlive, materialize, mergeStates, parseState, stableStringify } from '../services/sync/crdt';
import { SyncEngine } from '../services/sync/engine';
import { PullResponse, PushChange, PushResponse, RemoteChange, SyncHttpError, SyncTransport } from '../services/sync/http';

jest.setTimeout(120000);

// ---------------------------------------------------------------------------
// Servidor em memória com o mesmo contrato do backend (backend/src/routes/sync.ts)
// ---------------------------------------------------------------------------
class MemoryServer {
  seq = 0;
  docs = new Map<string, RemoteChange>();
  online = true;
  epoch = 'a1'.repeat(8);

  private check() {
    if (!this.online) throw new SyncHttpError('Não foi possível conectar ao servidor.', 0, 'network');
  }

  async pull(since: number, limit: number): Promise<PullResponse> {
    this.check();
    const rows = [...this.docs.values()].filter(d => d.seq > since).sort((a, b) => a.seq - b.seq);
    const changes = rows.slice(0, limit).map(r => ({ ...r }));
    return { changes, cursor: changes.length ? changes[changes.length - 1].seq : since, hasMore: rows.length > changes.length, latest: this.seq, epoch: this.epoch };
  }

  async push(changes: PushChange[]): Promise<PushResponse> {
    this.check();
    const res: PushResponse = { accepted: [], conflicts: [], rejected: [] };
    for (const c of changes) {
      const key = `${c.collection}/${c.id}`;
      const current = this.docs.get(key)?.seq ?? 0;
      if (c.baseSeq !== current) {
        res.conflicts.push({ collection: c.collection, id: c.id, seq: current });
        continue;
      }
      this.seq += 1;
      this.docs.set(key, { collection: c.collection, id: c.id, hlc: c.hlc, ciphertext: c.ciphertext, seq: this.seq });
      res.accepted.push({ collection: c.collection, id: c.id, seq: this.seq });
    }
    return res;
  }

  wipe() {
    this.docs.clear();
    this.seq = 0;
    this.epoch = 'b2'.repeat(8);
  }
}

/** Relógio de parede compartilhado pelo teste; cada aparelho pode estar adiantado ou atrasado. */
let WALL = Date.UTC(2026, 10, 3, 12, 0, 0);
const advance = (ms = 1000) => {
  WALL += ms;
};

let dbCount = 0;

interface Device {
  name: string;
  db: VaultDatabase;
  engine: SyncEngine;
  clock: HybridClock;
  /** Hook opcional: roda antes de cada push deste aparelho (simula outro aparelho enviando no meio). */
  beforePush?: () => Promise<void>;
  sync(): ReturnType<SyncEngine['sync']>;
  put(col: Collection, doc: any): Promise<void>;
  remove(col: Collection, id: string): Promise<void>;
  get<T = any>(col: Collection, id: string): Promise<T | null>;
  versions(id: string): Promise<CredentialVersion[]>;
}

async function device(server: MemoryServer, key: Uint8Array, name: string, offsetMs = 0): Promise<Device> {
  const db = new VaultDatabase();
  await db.open(`sync-test-${++dbCount}`, 'chave');
  const clock = new HybridClock(name, () => WALL + offsetMs);
  const dev = {} as Device;
  const transport: SyncTransport = {
    pull: (since, limit) => server.pull(since, limit),
    push: async changes => {
      const hook = dev.beforePush;
      dev.beforePush = undefined;
      if (hook) await hook();
      return server.push(changes);
    },
  };
  const engine = new SyncEngine(db, transport, key, clock);
  await engine.init();
  // Igual ao SyncService: cada escrita local passa pelo motor (captura com HLC + fila de envio)
  const pending: Promise<unknown>[] = [];
  db.onWrite(e => pending.push(engine.recordWrite(e)));
  Object.assign(dev, {
    name,
    db,
    engine,
    clock,
    async sync() {
      await Promise.all(pending.splice(0));
      await engine.reconcile();
      return engine.sync();
    },
    async put(col: Collection, doc: { id: string }) {
      advance();
      await db.put(col, doc);
      await Promise.all(pending.splice(0));
    },
    async remove(col: Collection, id: string) {
      advance();
      await db.remove(col, id);
      await Promise.all(pending.splice(0));
    },
    get: (col: Collection, id: string) => db.get(col, id),
    versions: async (id: string) => (await db.all<CredentialVersion>('versions')).filter(v => v.credentialId === id),
  });
  return dev;
}

const COLS: Collection[] = ['credentials', 'folders', 'notes', 'forms'];

async function snapshot(d: Device): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const c of COLS) out[c] = (await d.db.all<{ id: string }>(c)).sort((a, b) => a.id.localeCompare(b.id));
  return stableStringify(out);
}

async function expectConverged(...devs: Device[]) {
  const first = await snapshot(devs[0]);
  for (const d of devs.slice(1)) expect(await snapshot(d)).toBe(first);
}

const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p])));

const note = (title: string) => ({ id: uuid(), title, content: `conteúdo de ${title}`, createdAt: new Date(WALL).toISOString(), updatedAt: new Date(WALL).toISOString() });

// ---------------------------------------------------------------------------
// Criptografia da sincronização
// ---------------------------------------------------------------------------
describe('Chave de sincronização e código de pareamento', () => {
  it('o código de pareamento leva a chave com verificação de digitação', () => {
    const key = generateSyncKey();
    const code = encodePairingCode(key);
    expect(code.replace(/-/g, '')).toHaveLength(PAIRING_CODE_CHARS);
    expect(decodePairingCode(code)).toEqual(key);
    // Minúsculas, espaços e as trocas comuns (0/O, 1/I, 8/B) são aceitas
    expect(decodePairingCode(code.toLowerCase().replace(/-/g, ' '))).toEqual(key);
    expect(normalizePairingCode('ab0-1 8')).toBe('ABOIB');
    const typo = code[0] === 'A' ? 'B' + code.slice(1) : 'A' + code.slice(1);
    expect(() => decodePairingCode(typo)).toThrow('Código de pareamento incorreto');
    expect(() => decodePairingCode('ABCD')).toThrow(/tem 56 caracteres/);
    expect(() => decodePairingCode('x'.repeat(500))).toThrow('grande demais');
  });

  it('conta e segredo derivam da chave (HKDF) e não revelam a chave', () => {
    const key = generateSyncKey();
    const a = deriveSyncAccount(key);
    expect(a).toEqual(deriveSyncAccount(new Uint8Array(key)));
    expect(a.accountId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.authSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveSyncAccount(generateSyncKey()).accountId).not.toBe(a.accountId);
    expect(() => deriveSyncAccount(new Uint8Array(16))).toThrow('Chave de sincronização inválida');
  });

  it('cada bloco é ligado à coleção e ao id (AAD): o servidor não troca um documento pelo outro', () => {
    const key = generateSyncKey();
    const ct = encryptSyncDoc(key, 'credentials', 'abc', '{"senha":"segredo"}');
    expect(ct).not.toContain('segredo');
    expect(decryptSyncDoc(key, 'credentials', 'abc', ct)).toBe('{"senha":"segredo"}');
    expect(() => decryptSyncDoc(key, 'credentials', 'outro', ct)).toThrow();
    expect(() => decryptSyncDoc(key, 'notes', 'abc', ct)).toThrow();
    expect(() => decryptSyncDoc(generateSyncKey(), 'credentials', 'abc', ct)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CRDT puro
// ---------------------------------------------------------------------------
describe('CRDT: relógio lógico híbrido e fusão', () => {
  it('o HLC é monotônico mesmo com o relógio do aparelho voltando no tempo', () => {
    let t = 1_000_000;
    const c = new HybridClock('a1', () => t);
    const a = c.tick();
    t -= 60_000; // o usuário atrasou o relógio
    const b = c.tick();
    expect(b > a).toBe(true);
    c.observe(`${String(t + 500_000).padStart(15, '0')}:000003:b2`);
    expect(c.tick() > `${String(t + 500_000).padStart(15, '0')}:000003:b2`).toBe(true);
  });

  it('um relógio remoto mais de 24 h no futuro não arrasta o relógio local', () => {
    const t = 1_000_000_000;
    const c = new HybridClock('a1', () => t);
    c.observe(`${String(t + MAX_DRIFT_MS + 1000).padStart(15, '0')}:000000:zz`);
    expect(Number(c.tick().split(':')[0])).toBe(t);
    expect(() => new HybridClock('NÓ INVÁLIDO')).toThrow();
  });

  it('a fusão é comutativa, associativa e idempotente (estados aleatórios de 3 réplicas)', () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let t = 1000;
    const clocks = ['a', 'b', 'c'].map(n => new HybridClock(n, () => t));
    for (let round = 0; round < 60; round++) {
      const states: (DocState | null)[] = [null, null, null];
      for (let op = 0; op < 8; op++) {
        const i = rnd(3);
        t += rnd(3);
        const doc = materialize(states[i], 'x');
        const del = rnd(5) === 0;
        const next = del ? null : { ...(doc || {}), [`f${rnd(4)}`]: rnd(10) };
        states[i] = captureLocal(states[i], next, clocks[i]).state;
        if (rnd(3) === 0) states[(i + 1) % 3] = mergeStates(states[(i + 1) % 3], states[i]);
      }
      const [a, b, c] = states;
      const s = (x: DocState | null) => stableStringify(x);
      expect(s(mergeStates(a, b))).toBe(s(mergeStates(b, a)));
      expect(s(mergeStates(a, mergeStates(b, c)))).toBe(s(mergeStates(mergeStates(a, b), c)));
      expect(s(mergeStates(a, a))).toBe(s(a ? mergeStates(a, null) : null));
      expect(s(mergeStates(mergeStates(a, b), b))).toBe(s(mergeStates(a, b)));
    }
  });

  it('exclusão × edição concorrente: a edição vence e o documento volta inteiro; exclusão depois de ver a edição vence', () => {
    let t = 1000;
    const ca = new HybridClock('a', () => t);
    const cb = new HybridClock('b', () => t);
    const base = captureLocal(null, { title: 'Banco', password: 'v1' }, ca).state!;
    t++;
    const deleted = captureLocal(base, null, ca).state!;
    t++;
    const edited = captureLocal(base, { title: 'Banco', password: 'v2' }, cb).state!;
    const merged = mergeStates(deleted, edited)!;
    expect(isAlive(merged)).toBe(true);
    expect(materialize(merged, 'x')).toEqual({ id: 'x', title: 'Banco', password: 'v2' });
    t++;
    const deletedAfter = captureLocal(merged, null, ca).state!;
    expect(isAlive(mergeStates(deletedAfter, edited))).toBe(false);
  });

  it('estado remoto malicioso é rejeitado (chaves perigosas, HLC inválido, campos demais)', () => {
    const t = '000000000001000:000000:a';
    expect(parseState({ fields: { title: { v: 'x', t } }, del: null })).not.toBeNull();
    expect(parseState(JSON.parse(`{"fields":{"__proto__":{"v":1,"t":"${t}"}},"del":null}`))).toBeNull();
    expect(parseState({ fields: { id: { v: 'outro', t } } })).toBeNull();
    expect(parseState({ fields: { title: { v: 'x', t: 'amanhã' } } })).toBeNull();
    expect(parseState({ fields: { title: { t } } })).toBeNull();
    expect(parseState({ fields: { title: { v: 1, t } }, del: { t, seen: { constructor: t } } })).toBeNull();
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 201; i++) many[`f${i}`] = { v: i, t };
    expect(parseState({ fields: many })).toBeNull();
    expect(parseState('texto')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integração: aparelhos + motor + servidor
// ---------------------------------------------------------------------------
describe('Funcionalidade: Sincronização entre dispositivos', () => {
  it('Cenário: Sincronização bem-sucedida após edição, a senha adicionada no celular aparece no tablet', async () => {
    const server = new MemoryServer();
    const key = generateSyncKey();
    const celular = await device(server, key, 'celular');
    const tablet = await device(server, key, 'tablet');
    // Dado que eu tenho o aplicativo logado no celular e no tablet
    await celular.sync();
    await tablet.sync();
    // Quando eu adiciono uma nova senha no celular com internet conectada
    const cred = newCredential({ title: 'Nubank', username: 'lucas', password: 'Nova#Senha2026!x', url: 'nubank.com.br' });
    await celular.put('credentials', cred);
    const r = await celular.sync();
    expect(r.pushed).toBe(1);
    // O servidor só guarda blocos cifrados: nada do conteúdo em claro
    const stored = JSON.stringify([...server.docs.values()]);
    expect(stored).not.toContain('Nubank');
    expect(stored).not.toContain('Nova#Senha2026!x');
    // Então a senha aparece disponível no tablet
    const t = await tablet.sync();
    expect(t.applied).toBe(1);
    expect(await tablet.get('credentials', cred.id)).toEqual(cred);
    // E o eco não volta: a mudança recebida não é reenviada
    expect((await tablet.sync()).pushed).toBe(0);
    expect(await tablet.engine.pending()).toEqual([]);
  });

  it('Cenário: Conflito de sincronização (offline), mantém a versão salva mais recentemente e move a anterior para o histórico', async () => {
    for (const order of [['celular', 'tablet'], ['tablet', 'celular']]) {
      const server = new MemoryServer();
      const key = generateSyncKey();
      const devs: Record<string, Device> = { celular: await device(server, key, 'celular'), tablet: await device(server, key, 'tablet') };
      const cred = newCredential({ title: 'Gmail', username: 'lucas@gmail.com', password: 'Antiga#2025' });
      await devs.celular.put('credentials', cred);
      await devs.celular.sync();
      await devs.tablet.sync();
      // Dado que eu edito a mesma credencial em dois dispositivos enquanto ambos estão offline
      server.online = false;
      await devs.celular.put('credentials', { ...cred, password: 'Celular#2026' });
      await devs.tablet.put('credentials', { ...cred, password: 'Tablet#2026', notes: 'trocada no tablet' }); // mais recente
      await expect(devs.celular.sync()).rejects.toThrow('Não foi possível conectar');
      expect(await devs.celular.engine.pending()).toHaveLength(1);
      // Quando os dispositivos se conectam à internet (em qualquer ordem)
      server.online = true;
      for (const n of order) await devs[n].sync();
      for (const n of order) await devs[n].sync();
      // Então o aplicativo mantém a versão salva mais recentemente…
      await expectConverged(devs.celular, devs.tablet);
      const final = await devs.celular.get('credentials', cred.id);
      expect(final.password).toBe('Tablet#2026');
      expect(final.notes).toBe('trocada no tablet');
      // …e move a anterior para o histórico de versões: no celular, a edição dele que perdeu fica no histórico
      const history = await devs.celular.versions(cred.id);
      expect(history.map(v => v.snapshot.password)).toContain('Celular#2026');
      expect(history.find(v => v.snapshot.password === 'Celular#2026')!.summary).toMatch(/substituída/);
      // Se o tablet recebeu a versão do celular antes de enviar a dele, ela também fica no histórico do tablet
      if (order[0] === 'celular') expect((await devs.tablet.versions(cred.id)).map(v => v.snapshot.password)).toContain('Celular#2026');
    }
  });

  it('exclusão segura: a lápide não guarda a senha apagada nem nos aparelhos nem no servidor', async () => {
    const server = new MemoryServer();
    const key = generateSyncKey();
    const [a, b] = [await device(server, key, 'a'), await device(server, key, 'b')];
    const cred = newCredential({ title: 'Banco', username: 'lucas', password: 'SegredoApagado#2026' });
    await a.put('credentials', cred);
    await a.sync();
    await b.sync();
    await a.remove('credentials', cred.id);
    await a.sync();
    await b.sync();
    await a.sync();
    expect(await b.get('credentials', cred.id)).toBeNull();
    for (const d of [a, b]) {
      const dump = JSON.stringify(await Promise.all((await d.db.kvKeys('')).map(k => d.db.getKv(k))));
      expect(dump).not.toContain('SegredoApagado#2026');
    }
    const remote = [...server.docs.values()].find(r => r.id === cred.id)!;
    expect(decryptSyncDoc(key, 'credentials', cred.id, remote.ciphertext)).not.toContain('SegredoApagado#2026');
  });

  it('três aparelhos offline editando campos e documentos diferentes, sincronizando em todas as ordens: nada se perde', async () => {
    for (const order of permutations([0, 1, 2])) {
      const server = new MemoryServer();
      const key = generateSyncKey();
      const [a, b, c] = [await device(server, key, 'a'), await device(server, key, 'b'), await device(server, key, 'c')];
      const cred = newCredential({ title: 'Banco', username: 'lucas', password: 'Inicial#2026' });
      const folder = newFolder('Finanças');
      const n1 = note('Wi-Fi');
      await a.put('credentials', cred);
      await a.put('folders', folder);
      await a.put('notes', n1);
      for (const d of [a, b, c]) await d.sync();

      server.online = false;
      await a.put('credentials', { ...cred, password: 'DoA#2026' });
      await b.put('credentials', { ...cred, title: 'Banco do Brasil' });
      const n2 = note('Alarme');
      await b.put('notes', n2);
      await c.put('credentials', { ...cred, username: 'lucas.marins', folderId: folder.id });
      await c.remove('notes', n1.id);
      const form = { id: uuid(), kind: 'card', title: 'Cartão', fields: { number: '4111111111111111' } };
      await c.put('forms', form);
      server.online = true;

      const devs = [a, b, c];
      for (const i of order) await devs[i].sync();
      for (const i of order) await devs[i].sync();

      await expectConverged(a, b, c);
      expect(await b.get('credentials', cred.id)).toMatchObject({ title: 'Banco do Brasil', username: 'lucas.marins', password: 'DoA#2026', folderId: folder.id });
      expect(await a.get('notes', n1.id)).toBeNull();
      expect(await a.get('notes', n2.id)).toEqual(n2);
      expect(await b.get('forms', form.id)).toEqual(form);
      expect(await c.get('folders', folder.id)).toEqual(folder);
      for (const d of devs) expect(await d.engine.pending()).toEqual([]);
    }
  });

  it('exclusão × edição em aparelhos offline: a edição vence nas duas ordens e a credencial volta em todos', async () => {
    for (const deleterFirst of [true, false]) {
      const server = new MemoryServer();
      const key = generateSyncKey();
      const a = await device(server, key, 'a');
      const b = await device(server, key, 'b');
      const cred = newCredential({ title: 'Steam', username: 'gamer', password: 'Steam#2025' });
      await a.put('credentials', cred);
      await a.sync();
      await b.sync();
      server.online = false;
      await a.remove('credentials', cred.id);
      await b.put('credentials', { ...cred, password: 'Steam#2026' });
      server.online = true;
      const order = deleterFirst ? [a, b] : [b, a];
      for (const d of [...order, ...order]) await d.sync();
      await expectConverged(a, b);
      expect(await a.get('credentials', cred.id)).toMatchObject({ title: 'Steam', username: 'gamer', password: 'Steam#2026' });
    }
  });

  it('exclusão feita depois de ver a edição vence em todos os aparelhos (lápide)', async () => {
    const server = new MemoryServer();
    const key = generateSyncKey();
    const a = await device(server, key, 'a');
    const b = await device(server, key, 'b');
    const cred = newCredential({ title: 'Antiga', password: 'x' });
    await a.put('credentials', cred);
    await a.sync();
    await b.sync();
    await b.put('credentials', { ...cred, password: 'y' });
    await b.sync();
    await a.sync();
    await a.remove('credentials', cred.id);
    await a.sync();
    await b.sync();
    expect(await b.get('credentials', cred.id)).toBeNull();
    await expectConverged(a, b);
    // A lápide fica no servidor (cifrada): um terceiro aparelho que entra depois também não vê a credencial
    const c = await device(server, key, 'c');
    await c.sync();
    expect(await c.get('credentials', cred.id)).toBeNull();
  });

  it('relógio atrasado: depois de receber, o aparelho atrasado ainda vence com a edição seguinte (HLC); offline, converge sem perda', async () => {
    const server = new MemoryServer();
    const key = generateSyncKey();
    const a = await device(server, key, 'a');
    const atrasado = await device(server, key, 'atrasado', -2 * 60 * 60 * 1000);
    const cred = newCredential({ title: 'Banco', password: 'P1' });
    await a.put('credentials', cred);
    await a.sync();
    await atrasado.sync();
    // Edição causal: o atrasado já viu a de A, então a dele é "depois" mesmo com o relógio 2 h atrás
    await atrasado.put('credentials', { ...cred, password: 'P2' });
    await atrasado.sync();
    await a.sync();
    expect((await a.get('credentials', cred.id)).password).toBe('P2');

    // Concorrente offline: o relógio errado decide o LWW, mas os dois convergem e o perdedor fica no histórico
    server.online = false;
    await a.put('credentials', { ...cred, password: 'A3' });
    await atrasado.put('credentials', { ...cred, password: 'Atrasado3' });
    server.online = true;
    for (const d of [atrasado, a, atrasado, a]) await d.sync();
    await expectConverged(a, atrasado);
    const winner = (await a.get('credentials', cred.id)).password;
    const loser = winner === 'A3' ? 'Atrasado3' : 'A3';
    const loserDevice = winner === 'A3' ? atrasado : a;
    expect((await loserDevice.versions(cred.id)).map(v => v.snapshot.password)).toContain(loser);
  });

  it('envio concorrente no meio da sincronização: o servidor devolve conflito, o motor busca, funde e reenvia', async () => {
    const server = new MemoryServer();
    const key = generateSyncKey();
    const a = await device(server, key, 'a');
    const b = await device(server, key, 'b');
    const cred = newCredential({ title: 'Conta', username: 'u', password: 'p0' });
    await a.put('credentials', cred);
    await a.sync();
    await b.sync();
    await b.put('credentials', { ...cred, username: 'u-b' });
    await a.put('credentials', { ...cred, password: 'p-a' });
    // Entre o pull e o push de B, A envia a sua edição do mesmo documento
    b.beforePush = async () => {
      await a.sync();
    };
    const r = await b.sync();
    expect(r.conflicts).toBeGreaterThanOrEqual(1);
    await a.sync();
    await expectConverged(a, b);
    expect(await a.get('credentials', cred.id)).toMatchObject({ username: 'u-b', password: 'p-a' });
  });

  it('bloco adulterado ou trocado pelo servidor é ignorado sem corromper o cofre', async () => {
    const server = new MemoryServer();
    const key = generateSyncKey();
    const a = await device(server, key, 'a');
    const b = await device(server, key, 'b');
    const c1 = newCredential({ title: 'Um', password: '1' });
    const c2 = newCredential({ title: 'Dois', password: '2' });
    await a.put('credentials', c1);
    await a.put('credentials', c2);
    await a.sync();
    // O servidor troca o bloco de c1 pelo de c2 e adultera um byte de c2
    const d1 = server.docs.get(`credentials/${c1.id}`)!;
    const d2 = server.docs.get(`credentials/${c2.id}`)!;
    d1.ciphertext = d2.ciphertext;
    d2.ciphertext = d2.ciphertext.slice(0, 30) + (d2.ciphertext[30] === 'A' ? 'B' : 'A') + d2.ciphertext.slice(31);
    const r = await b.sync();
    expect(r.invalid).toBe(2);
    expect(await b.get('credentials', c1.id)).toBeNull();
    expect(await b.get('credentials', c2.id)).toBeNull();
    // Documento de coleção que não sincroniza também é ignorado
    server.docs.set('versions/x', { collection: 'versions', id: 'x', hlc: '000000000001000:000000:a', ciphertext: 'AAAA', seq: ++server.seq });
    expect((await b.sync()).invalid).toBe(1);
    expect(await b.db.all('versions')).toEqual([]);
    // O próximo envio de A substitui os blocos ruins
    await a.put('credentials', { ...c1, notes: 'reenviada' });
    await a.put('credentials', { ...c2, notes: 'reenviada' });
    await a.sync();
    await b.sync();
    expect((await b.get('credentials', c1.id)).title).toBe('Um');
    expect((await b.get('credentials', c2.id)).title).toBe('Dois');
  });

  it('offline: as alterações ficam na fila e vão quando a conexão volta; chave errada não lê nada', async () => {
    const server = new MemoryServer();
    const key = generateSyncKey();
    const a = await device(server, key, 'a');
    server.online = false;
    const docs = Array.from({ length: 5 }, (_, i) => newCredential({ title: `Conta ${i}`, password: `s${i}` }));
    for (const d of docs) await a.put('credentials', d);
    await expect(a.sync()).rejects.toBeInstanceOf(SyncHttpError);
    expect(await a.engine.pending()).toHaveLength(5);
    server.online = true;
    expect((await a.sync()).pushed).toBe(5);
    const intruso = await device(server, generateSyncKey(), 'intruso');
    const r = await intruso.sync();
    expect(r.invalid).toBe(5);
    expect(await intruso.db.all('credentials')).toEqual([]);
  });

  it('documentos criados antes de ativar a sincronização e escritas silenciosas também sobem (reconcile)', async () => {
    const server = new MemoryServer();
    const key = generateSyncKey();
    const a = await device(server, key, 'a');
    const antiga = newCredential({ title: 'Criada antes', password: 'x' });
    await a.db.put('credentials', antiga, { silent: true });
    expect((await a.sync()).pushed).toBe(1);
    await a.db.put('credentials', { ...antiga, usageCount: 3 }, { silent: true });
    expect((await a.sync()).pushed).toBe(1);
    const b = await device(server, key, 'b');
    await b.sync();
    expect((await b.get('credentials', antiga.id)).usageCount).toBe(3);
  });

  it('servidor apagado ou trocado: o aparelho percebe (cursor atrás ou epoch diferente) e reenvia tudo', async () => {
    for (const othersFirst of [false, true]) {
      const server = new MemoryServer();
      const key = generateSyncKey();
      const a = await device(server, key, 'a');
      const creds = Array.from({ length: 3 }, (_, i) => newCredential({ title: `C${i}`, password: `p${i}` }));
      for (const c of creds) await a.put('credentials', c);
      await a.sync();
      server.wipe();
      const b = await device(server, key, 'b');
      if (othersFirst) {
        // Outro aparelho envia mais documentos antes: o contador do servidor passa o de A, mas o epoch denuncia
        for (let i = 0; i < 5; i++) await b.put('notes', note(`N${i}`));
        await b.sync();
      }
      expect((await a.sync()).pushed).toBe(3);
      await b.sync();
      await expectConverged(a, b);
      expect(await b.db.all('credentials')).toHaveLength(3);
    }
  });

  it('mover pastas ao mesmo tempo não cria ciclo; excluir a pasta enquanto outro aparelho a usa não deixa referência solta', async () => {
    const server = new MemoryServer();
    const key = generateSyncKey();
    const a = await device(server, key, 'a');
    const b = await device(server, key, 'b');
    const x = newFolder('X');
    const y = newFolder('Y');
    const z = newFolder('Z');
    await a.put('folders', x);
    await a.put('folders', y);
    await a.put('folders', z);
    await a.sync();
    await b.sync();
    server.online = false;
    await a.put('folders', { ...x, parentId: y.id }); // X dentro de Y
    await b.put('folders', { ...y, parentId: x.id }); // Y dentro de X
    await a.remove('folders', z.id);
    const cred = newCredential({ title: 'Na pasta Z', password: 'z' });
    await b.put('credentials', { ...cred, folderId: z.id });
    await b.put('notes', { ...note('Nota em Z'), folderId: z.id });
    server.online = true;
    for (const d of [a, b, a, b]) await d.sync();
    await expectConverged(a, b);
    const folders = await a.db.all<any>('folders');
    const roots = folders.filter(f => !f.parentId).map(f => f.id);
    expect(roots).toContain([x.id, y.id].sort()[0]);
    expect(folders.find(f => f.id === z.id)).toBeUndefined();
    expect((await b.get('credentials', cred.id)).folderId).toBeNull();
    expect((await b.db.all<any>('notes'))[0].folderId).toBeNull();
  });

  it('a fusão é idempotente na prática: receber de novo o mesmo histórico não muda nada nem gera envio', async () => {
    const server = new MemoryServer();
    const key = generateSyncKey();
    const a = await device(server, key, 'a');
    const b = await device(server, key, 'b');
    await a.put('credentials', newCredential({ title: 'X', password: '1' }));
    await a.put('notes', note('N'));
    await a.sync();
    await b.sync();
    const before = await snapshot(b);
    await b.db.setKv('sync:cursor', '0');
    const r = await b.sync();
    expect(r.applied).toBe(0);
    expect(r.pushed).toBe(0);
    expect(await snapshot(b)).toBe(before);
  });
});
