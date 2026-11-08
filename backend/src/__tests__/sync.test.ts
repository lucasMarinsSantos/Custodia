// Push/pull de blocos cifrados: validação, limites, paginação, isolamento e dois aparelhos concorrentes.
import request from 'supertest';
import { bearer, blob, hlc, login, makeApp, registerAndLogin } from './helpers';

type App = ReturnType<typeof makeApp>['app'];

const change = (id: string, baseSeq = 0, extra: Record<string, unknown> = {}) => ({
  collection: 'credentials',
  id,
  hlc: hlc(),
  ciphertext: blob(),
  baseSeq,
  ...extra,
});

const push = (app: App, token: string, changes: unknown[]) => request(app).post('/api/sync/push').set(bearer(token)).send({ changes });
const pull = (app: App, token: string, query = 'since=0') => request(app).get(`/api/sync/pull?${query}`).set(bearer(token));

describe('Sincronização', () => {
  const { app, db } = makeApp({ limits: { maxDocsPerAccount: 5, maxBytesPerAccount: 2000, maxCiphertextChars: 600, maxPullPageBytes: 400 } });

  it('push aceita blocos cifrados, numera com seq por conta e o pull os devolve iguais', async () => {
    const { token } = await registerAndLogin(app);
    const c1 = change('cred-1');
    const c2 = { ...change('folder-1'), collection: 'folders' };
    const r = await push(app, token, [c1, c2]).expect(200);
    expect(r.body.accepted).toEqual([
      { collection: 'credentials', id: 'cred-1', seq: 1 },
      { collection: 'folders', id: 'folder-1', seq: 2 },
    ]);
    expect(r.body.conflicts).toEqual([]);
    const p = await pull(app, token).expect(200);
    expect(p.body).toMatchObject({ cursor: 2, hasMore: false, latest: 2 });
    expect(p.body.changes[0]).toEqual({ collection: 'credentials', id: 'cred-1', hlc: c1.hlc, ciphertext: c1.ciphertext, seq: 1 });
    // O servidor guarda exatamente o bloco recebido: não decifra nem reinterpreta.
    const row = db.prepare("SELECT ciphertext FROM docs WHERE doc_id = 'cred-1'").get() as { ciphertext: string };
    expect(row.ciphertext).toBe(c1.ciphertext);
    const empty = await pull(app, token, 'since=2').expect(200);
    expect(empty.body).toMatchObject({ changes: [], cursor: 2, hasMore: false });
  });

  it('valida coleção, id, HLC, ciphertext, baseSeq, repetição e quantidade', async () => {
    const { token } = await registerAndLogin(app);
    const cases: [unknown, RegExp][] = [
      [[change('a', 0, { collection: 'versions' })], /collection inválida/],
      [[change('a', 0, { collection: 'accessLog' })], /collection inválida/],
      [[change('../etc', 0)], /id inválido/],
      [[change('a', 0, { hlc: '9999' })], /hlc inválido/],
      [[change('a', 0, { ciphertext: 'não é base64!' })], /ciphertext/],
      [[change('a', 0, { ciphertext: 'AAAA' })], /ciphertext/],
      [[change('a', 0, { ciphertext: { $gt: '' } })], /ciphertext/],
      [[change('a', -1)], /baseSeq inválido/],
      [[change('a', 1.5)], /baseSeq inválido/],
      [[change('a'), change('a')], /repetido/],
      [[null], /collection inválida/],
    ];
    for (const [changes, msg] of cases) {
      const r = await push(app, token, changes as unknown[]).expect(400);
      expect(r.body.error).toMatch(msg);
    }
    await request(app).post('/api/sync/push').set(bearer(token)).send({}).expect(400);
    const many = Array.from({ length: 201 }, (_, i) => change(`d${i}`));
    expect((await push(app, token, many).expect(400)).body.error).toMatch(/Máximo de 200/);
  });

  it('valida since e limit do pull', async () => {
    const { token } = await registerAndLogin(app);
    await pull(app, token, 'since=-1').expect(400);
    await pull(app, token, 'since=abc').expect(400);
    await pull(app, token, 'since=0&limit=0').expect(400);
    await pull(app, token, 'since=0&limit=501').expect(400);
    await pull(app, token, 'since[]=1').expect(400);
  });

  it('paginação pelo cursor (limite de itens e de bytes por página), sem pular nem repetir', async () => {
    const { token } = await registerAndLogin(app);
    await push(app, token, ['p1', 'p2', 'p3', 'p4'].map(id => change(id))).expect(200);
    const seen: string[] = [];
    let since = 0;
    let pages = 0;
    for (;;) {
      const r = await pull(app, token, `since=${since}&limit=2`).expect(200);
      expect(r.body.changes.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.changes.map((c: { id: string }) => c.id));
      since = r.body.cursor;
      pages++;
      if (!r.body.hasMore) break;
    }
    expect(seen).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(pages).toBe(2);
    // Página limitada por bytes (400 caracteres; cada bloco tem 124): cabem 3 por página.
    const byBytes = await pull(app, token, 'since=0&limit=500').expect(200);
    expect(byBytes.body.changes).toHaveLength(3);
    expect(byBytes.body.hasMore).toBe(true);
  });

  it('documento grande demais e cota da conta voltam como rejeitados (o resto do envio passa)', async () => {
    const { token } = await registerAndLogin(app);
    const big = change('grande', 0, { ciphertext: blob(500) });
    const r = await push(app, token, [big, change('ok-1')]).expect(200);
    expect(r.body.rejected).toEqual([{ collection: 'credentials', id: 'grande', reason: 'too_large' }]);
    expect(r.body.accepted.map((a: { id: string }) => a.id)).toEqual(['ok-1']);
    const fill = await push(app, token, ['q2', 'q3', 'q4', 'q5', 'q6'].map(id => change(id))).expect(200);
    expect(fill.body.accepted).toHaveLength(4);
    expect(fill.body.rejected).toEqual([{ collection: 'credentials', id: 'q6', reason: 'quota' }]);
    // Atualizar um documento existente não conta como documento novo.
    const upd = await push(app, token, [change('ok-1', r.body.accepted[0].seq)]).expect(200);
    expect(upd.body.accepted).toHaveLength(1);
    const status = await request(app).get('/api/sync/status').set(bearer(token)).expect(200);
    expect(status.body.docs).toBe(5);
    expect(status.body.limits.maxDocsPerAccount).toBe(5);
  });

  it('cota de bytes por conta', async () => {
    const { token } = await registerAndLogin(app);
    const r = await push(app, token, ['b1', 'b2', 'b3', 'b4'].map(id => change(id, 0, { ciphertext: blob(400) }))).expect(200);
    // Cada bloco tem 572 caracteres: cabem 3 em 2000.
    expect(r.body.accepted).toHaveLength(3);
    expect(r.body.rejected).toEqual([{ collection: 'credentials', id: 'b4', reason: 'quota' }]);
  });

  it('isolamento: um usuário não lê nem sobrescreve os documentos de outro', async () => {
    const alice = await registerAndLogin(app, 'Alice');
    const bob = await registerAndLogin(app, 'Bob');
    const secret = change('mesmo-id');
    await push(app, alice.token, [secret]).expect(200);
    const bobPull = await pull(app, bob.token).expect(200);
    expect(bobPull.body.changes).toEqual([]);
    expect(bobPull.body.latest).toBe(0);
    // Mesmo id de documento em outra conta: espaço separado, não há conflito nem vazamento.
    const mine = change('mesmo-id');
    const r = await push(app, bob.token, [mine]).expect(200);
    expect(r.body.accepted).toEqual([{ collection: 'credentials', id: 'mesmo-id', seq: 1 }]);
    const alicePull = await pull(app, alice.token).expect(200);
    expect(alicePull.body.changes.map((c: { ciphertext: string }) => c.ciphertext)).toEqual([secret.ciphertext]);
    const bobAgain = await pull(app, bob.token).expect(200);
    expect(bobAgain.body.changes.map((c: { ciphertext: string }) => c.ciphertext)).toEqual([mine.ciphertext]);
  });
});

describe('Dois aparelhos concorrentes', () => {
  const { app } = makeApp();

  it('envios simultâneos do mesmo documento: um é aceito e o outro volta como conflito (nada é sobrescrito às cegas)', async () => {
    const phone = await registerAndLogin(app, 'Celular');
    const tablet = await login(app, phone.acc, undefined, 'Tablet');
    const [a, b] = await Promise.all([push(app, phone.token, [change('cred-x')]), push(app, tablet.token, [change('cred-x')])]);
    const results = [a.body, b.body];
    expect(results.map(r => r.accepted.length).sort()).toEqual([0, 1]);
    const loser = results.find(r => r.conflicts.length)!;
    expect(loser.conflicts).toEqual([{ collection: 'credentials', id: 'cred-x', seq: 1 }]);
  });

  it('o perdedor faz pull, funde e reenvia com o baseSeq novo; os dois convergem no mesmo estado', async () => {
    const phone = await registerAndLogin(app, 'Celular');
    const tablet = await login(app, phone.acc, undefined, 'Tablet');
    await push(app, phone.token, [change('doc')]).expect(200);
    // O tablet ainda não viu a versão 1 e tenta enviar a dele como nova.
    const conflict = await push(app, tablet.token, [change('doc', 0)]).expect(200);
    expect(conflict.body.conflicts[0].seq).toBe(1);
    const seen = await pull(app, tablet.token).expect(200);
    const merged = change('doc', seen.body.changes[0].seq);
    const ok = await push(app, tablet.token, [merged]).expect(200);
    expect(ok.body.accepted).toEqual([{ collection: 'credentials', id: 'doc', seq: 2 }]);
    // O celular puxa a partir do cursor dele e recebe a versão fundida do tablet.
    const phonePull = await pull(app, phone.token, 'since=1').expect(200);
    expect(phonePull.body.changes.map((c: { ciphertext: string }) => c.ciphertext)).toEqual([merged.ciphertext]);
    const tabletPull = await pull(app, tablet.token, 'since=0').expect(200);
    expect(tabletPull.body.changes[0].ciphertext).toBe(merged.ciphertext);
  });

  it('muitos envios em paralelo de dois aparelhos: o seq é único e crescente, sem perda de documentos', async () => {
    const phone = await registerAndLogin(app, 'Celular');
    const tablet = await login(app, phone.acc, undefined, 'Tablet');
    const reqs = [];
    for (let i = 0; i < 20; i++) reqs.push(push(app, i % 2 ? tablet.token : phone.token, [change(`n${i}`)]));
    const res = await Promise.all(reqs);
    const seqs = res.flatMap(r => r.body.accepted.map((a: { seq: number }) => a.seq)).sort((x: number, y: number) => x - y);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const all = await pull(app, tablet.token, 'since=0&limit=500').expect(200);
    expect(all.body.changes).toHaveLength(20);
  });

  it('corpo do push acima do limite → 413; sem token o servidor nem lê o corpo', async () => {
    const phone = await registerAndLogin(app);
    await request(app).post('/api/sync/push').send({ changes: [] }).expect(401);
    const huge = { changes: [change('x', 0, { ciphertext: 'A'.repeat(10 * 1024 * 1024) })] };
    await request(app).post('/api/sync/push').set(bearer(phone.token)).send(huge).expect(413);
  });
});

describe('Migração do banco do servidor', () => {
  it('banco antigo sem epoch ganha a coluna com valor aleatório por conta', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const { openDatabase } = require('../db');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'custodia-')), 'old.sqlite');
    const old = new Database(file);
    old.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, auth_hash TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL); INSERT INTO accounts VALUES ('a', 'h', 0, 'x'), ('b', 'h', 0, 'x');");
    old.close();
    const db = openDatabase(file);
    const rows = db.prepare('SELECT epoch FROM accounts ORDER BY id').all() as { epoch: string }[];
    db.close();
    expect(rows[0].epoch).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[0].epoch).not.toBe(rows[1].epoch);
  });
});
