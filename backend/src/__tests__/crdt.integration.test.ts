// Teste de integração do CRDT com o servidor real.
//
// Sobe o servidor HTTP numa porta efêmera e simula dois ou três aparelhos que usam o MESMO CRDT do app
// (src/services/sync/crdt.ts: LWW-Map por campo com HLC e lápides) e o mesmo formato de bloco cifrado
// (AES-256-GCM, versão + nonce + ciphertext + tag, AAD = coleção + id). Os aparelhos editam offline e
// sincronizam em ordens diferentes, inclusive ao mesmo tempo. Confirma que todos convergem e que nada se perde.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import {
  HybridClock,
  captureLocal,
  materialize,
  mergeStates,
  parseState,
  stableStringify,
  stateClock,
  stateClocks,
  type DocState,
} from '../../../src/services/sync/crdt';
import { makeApp } from './helpers';

jest.setTimeout(60000);

// ---------------------------------------------------------------------------
// Criptografia no formato do app (src/crypto/sync.ts e src/crypto/index.ts)
// ---------------------------------------------------------------------------
const SALT = Buffer.from('custodia-sync-v1');
const derive = (key: Buffer, info: string, len: number) => Buffer.from(hkdfSync('sha256', key, SALT, Buffer.from(info), len)).toString('hex');
const aad = (col: string, id: string) => Buffer.from(`custodia-sync:v1:${col}:${id}`);

function encrypt(key: Buffer, col: string, id: string, text: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad(col, id));
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, ct, c.getAuthTag()]).toString('base64');
}

function decrypt(key: Buffer, col: string, id: string, b64: string): string {
  const data = Buffer.from(b64, 'base64');
  if (data.length < 29 || data[0] !== 1) throw new Error('Formato cifrado inválido');
  const d = createDecipheriv('aes-256-gcm', key, data.subarray(1, 13));
  d.setAAD(aad(col, id));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(13, data.length - 16)), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Aparelho simulado: banco local, metadados CRDT, fila e cursor (mesma lógica do SyncEngine do app)
// ---------------------------------------------------------------------------
type Doc = Record<string, unknown> & { id: string };
let WALL = Date.UTC(2026, 10, 3, 12);

class Device {
  docs = new Map<string, Doc>();
  meta = new Map<string, { s: DocState; q: number }>();
  pending = new Set<string>();
  cursor = 0;
  token = '';
  online = true;
  readonly clock: HybridClock;
  readonly deviceId = randomBytes(8).toString('hex');

  constructor(private readonly base: string, private readonly key: Buffer, readonly name: string, offsetMs = 0) {
    this.clock = new HybridClock(name, () => WALL + offsetMs);
  }

  get account() {
    return { accountId: derive(this.key, 'account-id', 16), authSecret: derive(this.key, 'auth', 32) };
  }

  private async http(method: string, path: string, body?: unknown) {
    if (!this.online) throw new Error('offline');
    const res = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  }

  async register() {
    expect((await this.http('POST', '/api/auth/register', this.account)).status).toBe(201);
  }

  async login() {
    const r = await this.http('POST', '/api/auth/login', { ...this.account, device: { id: this.deviceId, name: this.name } });
    expect(r.status).toBe(200);
    this.token = r.body.token;
  }

  private write(key: string, doc: Doc | null) {
    WALL += 1000;
    const { state, changed } = captureLocal(this.meta.get(key)?.s ?? null, doc, this.clock);
    if (!changed || !state) return;
    this.meta.set(key, { s: state, q: this.meta.get(key)?.q ?? 0 });
    this.pending.add(key);
  }

  put(col: string, doc: Doc) {
    this.docs.set(`${col}:${doc.id}`, JSON.parse(JSON.stringify(doc)));
    this.write(`${col}:${doc.id}`, doc);
  }

  remove(col: string, id: string) {
    this.docs.delete(`${col}:${id}`);
    this.write(`${col}:${id}`, null);
  }

  get(col: string, id: string) {
    return this.docs.get(`${col}:${id}`) ?? null;
  }

  private applyRemote(c: { collection: string; id: string; ciphertext: string; seq: number }) {
    const key = `${c.collection}:${c.id}`;
    const meta = this.meta.get(key);
    if (meta && meta.q >= c.seq) return;
    const remote = parseState(JSON.parse(decrypt(this.key, c.collection, c.id, c.ciphertext)));
    if (!remote) throw new Error('estado inválido');
    stateClocks(remote).forEach(t => this.clock.observe(t));
    const merged = mergeStates(meta?.s ?? null, remote)!;
    const doc = materialize(merged, c.id) as Doc | null;
    if (doc) this.docs.set(key, doc);
    else this.docs.delete(key);
    this.meta.set(key, { s: merged, q: c.seq });
    if (stableStringify(merged) === stableStringify(remote)) this.pending.delete(key);
    else this.pending.add(key);
  }

  private async pull() {
    for (;;) {
      const r = await this.http('GET', `/api/sync/pull?since=${this.cursor}&limit=2`);
      expect(r.status).toBe(200);
      for (const c of r.body.changes) this.applyRemote(c);
      this.cursor = r.body.cursor;
      if (!r.body.hasMore) return;
    }
  }

  /** Envia a fila; devolve quantos voltaram como conflito. */
  private async push(): Promise<number> {
    if (!this.pending.size) return 0;
    const sent = new Map<string, string>();
    const changes = [...this.pending].map(key => {
      const [collection, id] = key.split(':');
      const m = this.meta.get(key)!;
      sent.set(key, stableStringify(m.s));
      return { collection, id, hlc: stateClock(m.s), ciphertext: encrypt(this.key, collection, id, JSON.stringify(m.s)), baseSeq: m.q };
    });
    const r = await this.http('POST', '/api/sync/push', { changes });
    expect(r.status).toBe(200);
    for (const a of r.body.accepted) {
      const key = `${a.collection}:${a.id}`;
      const m = this.meta.get(key)!;
      this.meta.set(key, { s: m.s, q: a.seq });
      if (stableStringify(m.s) === sent.get(key)) this.pending.delete(key);
    }
    return r.body.conflicts.length;
  }

  /** pull → push; em conflito (alguém enviou antes), busca, funde e reenvia. */
  async sync(): Promise<number> {
    let conflicts = 0;
    for (let round = 0; round < 6; round++) {
      await this.pull();
      const c = await this.push();
      conflicts += c;
      if (!c) return conflicts;
    }
    throw new Error('não convergiu');
  }

  snapshot() {
    return stableStringify([...this.docs.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

// ---------------------------------------------------------------------------
// Servidor real em porta efêmera
// ---------------------------------------------------------------------------
let server: Server;
let base = '';
let db: ReturnType<typeof makeApp>['db'];

beforeAll(async () => {
  const made = makeApp();
  db = made.db;
  server = made.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(r => server.close(r));
  db.close();
});

async function connect(names: string[], offsets: number[] = []) {
  const key = randomBytes(32);
  const devs = names.map((n, i) => new Device(base, key, n, offsets[i] ?? 0));
  await devs[0].register();
  for (const d of devs) await d.login();
  return devs;
}

const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p])));

function expectConverged(devs: Device[]) {
  for (const d of devs.slice(1)) expect(d.snapshot()).toBe(devs[0].snapshot());
  for (const d of devs) expect(d.pending.size).toBe(0);
}

describe('CRDT + servidor: aparelhos concorrentes sem perda de dados', () => {
  it('três aparelhos editam offline e sincronizam em todas as ordens: convergem com todas as edições', async () => {
    for (const order of permutations([0, 1, 2])) {
      const devs = await connect(['celular', 'tablet', 'notebook']);
      const [a, b, c] = devs;
      a.put('credentials', { id: 'cred1', title: 'Banco', username: 'lucas', password: 'Inicial#1' });
      a.put('folders', { id: 'pasta1', name: 'Finanças' });
      a.put('notes', { id: 'nota1', title: 'Wi-Fi', content: 'senha do roteador' });
      for (const d of devs) await d.sync();

      for (const d of devs) d.online = false;
      a.put('credentials', { id: 'cred1', title: 'Banco', username: 'lucas', password: 'DoCelular#2' });
      b.put('credentials', { id: 'cred1', title: 'Banco do Brasil', username: 'lucas', password: 'Inicial#1' });
      b.put('notes', { id: 'nota2', title: 'Alarme', content: '1234' });
      c.put('credentials', { id: 'cred1', title: 'Banco', username: 'lucas.marins', password: 'Inicial#1', folderId: 'pasta1' });
      c.remove('notes', 'nota1');
      c.put('forms', { id: 'cartao1', kind: 'card', number: '4111111111111111' });
      for (const d of devs) d.online = true;

      for (const i of [...order, ...order]) await devs[i].sync();
      expectConverged(devs);
      expect(b.get('credentials', 'cred1')).toEqual({ id: 'cred1', title: 'Banco do Brasil', username: 'lucas.marins', password: 'DoCelular#2', folderId: 'pasta1' });
      expect(a.get('notes', 'nota1')).toBeNull();
      expect(a.get('notes', 'nota2')).toEqual({ id: 'nota2', title: 'Alarme', content: '1234' });
      expect(c.get('forms', 'cartao1')).toMatchObject({ number: '4111111111111111' });
    }
  });

  it('dois aparelhos sincronizam AO MESMO TEMPO o mesmo documento: o conflito é resolvido pelo reenvio e ninguém perde a edição', async () => {
    for (let run = 0; run < 5; run++) {
      const [a, b] = await connect(['a', 'b']);
      a.put('credentials', { id: 'x', title: 'Conta', username: 'u', password: 'p' });
      await a.sync();
      await b.sync();
      a.put('credentials', { id: 'x', title: 'Conta', username: 'u', password: 'nova-de-a' });
      b.put('credentials', { id: 'x', title: 'Conta', username: 'u-de-b', password: 'p' });
      for (let i = 0; i < 5; i++) {
        a.put('notes', { id: `a${run}-${i}`, t: i });
        b.put('notes', { id: `b${run}-${i}`, t: i });
      }
      await Promise.all([a.sync(), b.sync()]);
      await a.sync();
      await b.sync();
      expectConverged([a, b]);
      expect(a.get('credentials', 'x')).toMatchObject({ username: 'u-de-b', password: 'nova-de-a' });
      expect([...a.docs.keys()].filter(k => k.startsWith('notes:'))).toHaveLength(10);
    }
  });

  it('exclusão × edição concorrente: a edição vence nas duas ordens; exclusão depois de ver a edição vence', async () => {
    for (const deleterFirst of [true, false]) {
      const [a, b] = await connect(['a', 'b']);
      a.put('credentials', { id: 'steam', title: 'Steam', password: 'v1' });
      await a.sync();
      await b.sync();
      a.remove('credentials', 'steam');
      b.put('credentials', { id: 'steam', title: 'Steam', password: 'v2' });
      const order = deleterFirst ? [a, b, a, b] : [b, a, b, a];
      for (const d of order) await d.sync();
      expectConverged([a, b]);
      expect(a.get('credentials', 'steam')).toEqual({ id: 'steam', title: 'Steam', password: 'v2' });

      a.remove('credentials', 'steam');
      await a.sync();
      await b.sync();
      expect(b.get('credentials', 'steam')).toBeNull();
      expectConverged([a, b]);
    }
  });

  it('relógio atrasado 2 h: a edição feita depois de receber vence (HLC); concorrente, converge igual nos dois', async () => {
    const [a, late] = await connect(['a', 'atrasado'], [0, -2 * 60 * 60 * 1000]);
    a.put('credentials', { id: 'c', title: 'Banco', password: 'P1' });
    await a.sync();
    await late.sync();
    late.put('credentials', { id: 'c', title: 'Banco', password: 'P2' });
    await late.sync();
    await a.sync();
    expect(a.get('credentials', 'c')).toMatchObject({ password: 'P2' });

    a.put('credentials', { id: 'c', title: 'Banco', password: 'A3' });
    late.put('credentials', { id: 'c', title: 'Banco', password: 'L3' });
    await Promise.all([a.sync(), late.sync()]);
    await a.sync();
    await late.sync();
    expectConverged([a, late]);
  });

  it('o servidor guarda só blocos cifrados: nenhum título, usuário ou senha aparece no banco dele', async () => {
    const [a] = await connect(['a']);
    a.put('credentials', { id: 'segredo1', title: 'TituloSecretoXYZ', username: 'usuarioSecretoXYZ', password: 'SenhaSecretaXYZ' });
    await a.sync();
    const dump = JSON.stringify(db.prepare('SELECT * FROM docs').all()) + JSON.stringify(db.prepare('SELECT * FROM accounts').all());
    for (const s of ['TituloSecretoXYZ', 'usuarioSecretoXYZ', 'SenhaSecretaXYZ', a.account.authSecret]) expect(dump).not.toContain(s);
  });

  it('o epoch da conta vem no pull (o app reenvia tudo se ele mudar)', async () => {
    const [a] = await connect(['a']);
    const r = await fetch(`${base}/api/sync/pull?since=0`, { headers: { Authorization: `Bearer ${a.token}` } });
    const body = await r.json();
    expect(body.epoch).toMatch(/^[0-9a-f]{32}$/);
  });
});
