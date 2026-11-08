// Conta, sessão (JWT de vida curta), aparelhos e configuração.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../config';
import { verifySecret, hashSecret } from '../secrets';
import { bearer, deviceId, login, makeApp, newAccount, registerAndLogin } from './helpers';

describe('Configuração', () => {
  it('JWT_SECRET é obrigatório em produção (e precisa de 32+ caracteres)', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET é obrigatório/);
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'curto' })).toThrow(/32 caracteres/);
    expect(loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) }).jwtSecret).toBe('x'.repeat(32));
  });

  it('fora de produção gera um segredo temporário; valida números do ambiente', () => {
    expect(loadConfig({}).jwtSecret).toHaveLength(64);
    expect(loadConfig({ PORT: '4000', MAX_DOCS_PER_ACCOUNT: '5' })).toMatchObject({ port: 4000, limits: { maxDocsPerAccount: 5 } });
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('PORT deve ser um inteiro positivo');
    expect(() => loadConfig({ RATE_LOGIN_PER_15MIN: '-1' })).toThrow(/RATE_LOGIN/);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });

  it('o hash do segredo usa scrypt com sal e rejeita formatos estranhos', async () => {
    const h1 = await hashSecret('a'.repeat(64));
    const h2 = await hashSecret('a'.repeat(64));
    expect(h1).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(h1).not.toBe(h2);
    expect(await verifySecret('a'.repeat(64), h1)).toBe(true);
    expect(await verifySecret('b'.repeat(64), h1)).toBe(false);
    expect(await verifySecret('a'.repeat(64), 'bcrypt$xyz')).toBe(false);
  });
});

describe('Conta e login', () => {
  const { app, db } = makeApp();

  it('health responde sem autenticação', async () => {
    const r = await request(app).get('/api/health').expect(200);
    expect(r.body).toMatchObject({ status: 'ok', version: '2.0.0' });
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('cadastro valida os campos, cria a conta e recusa duplicada', async () => {
    const acc = newAccount();
    await request(app).post('/api/auth/register').send({ accountId: 'xyz', authSecret: acc.authSecret }).expect(400);
    await request(app).post('/api/auth/register').send({ accountId: acc.accountId, authSecret: 'senha-mestra' }).expect(400);
    await request(app).post('/api/auth/register').send(acc).expect(201);
    await request(app).post('/api/auth/register').send(acc).expect(409);
  });

  it('o servidor guarda só o hash do segredo (nunca o segredo em claro)', async () => {
    const acc = newAccount();
    await request(app).post('/api/auth/register').send(acc).expect(201);
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc.accountId) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(acc.authSecret);
    expect(String(row.auth_hash)).toMatch(/^scrypt\$/);
  });

  it('login: segredo errado e conta inexistente dão a mesma resposta (sem enumeração)', async () => {
    const acc = newAccount();
    await request(app).post('/api/auth/register').send(acc).expect(201);
    const wrong = await login(app, { accountId: acc.accountId, authSecret: 'f'.repeat(64) });
    const ghost = await login(app, newAccount());
    expect(wrong.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(wrong.body.error).toBe(ghost.body.error);
    const bad = await request(app).post('/api/auth/login').send({ ...acc, device: { id: 'A!', name: 'x' } });
    expect(bad.status).toBe(400);
    const noName = await request(app).post('/api/auth/login').send({ ...acc, device: { id: deviceId(), name: '\u0000\u0001' } });
    expect(noName.status).toBe(400);
  });

  it('login devolve JWT de vida curta ligado ao aparelho', async () => {
    const { token, deviceId: did, acc } = await registerAndLogin(app);
    const payload = jwt.decode(token) as jwt.JwtPayload;
    expect(payload.sub).toBe(acc.accountId);
    expect(payload.did).toBe(did);
    expect(payload.exp! - payload.iat!).toBe(15 * 60);
  });

  it('rotas protegidas recusam token ausente, adulterado, de outra audiência ou expirado', async () => {
    const { token, acc, deviceId: did } = await registerAndLogin(app);
    await request(app).get('/api/sync/status').expect(401);
    await request(app).get('/api/sync/status').set({ Authorization: token }).expect(401);
    await request(app).get('/api/sync/status').set(bearer(token.slice(0, -2) + 'xx')).expect(401);
    const secret = 'segredo-de-teste-com-mais-de-32-caracteres';
    const otherAud = jwt.sign({ did }, secret, { subject: acc.accountId, audience: 'outra', expiresIn: 60 });
    await request(app).get('/api/sync/status').set(bearer(otherAud)).expect(401);
    const expired = jwt.sign({ did }, secret, { subject: acc.accountId, audience: 'custodia-sync', expiresIn: -10 });
    await request(app).get('/api/sync/status').set(bearer(expired)).expect(401);
    const none = jwt.sign({ did }, '', { algorithm: 'none', subject: acc.accountId, audience: 'custodia-sync' } as jwt.SignOptions);
    await request(app).get('/api/sync/status').set(bearer(none)).expect(401);
    const badSub = jwt.sign({ did }, secret, { subject: 'nao-hex', audience: 'custodia-sync', expiresIn: 60 });
    await request(app).get('/api/sync/status').set(bearer(badSub)).expect(401);
    await request(app).get('/api/sync/status').set(bearer(token)).expect(200);
  });

  it('CORS fechado: requisições de navegador (com Origin) e preflight são recusadas, sem cabeçalhos CORS', async () => {
    const r = await request(app).get('/api/health').set('Origin', 'https://site-malicioso.com');
    expect(r.status).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await request(app).options('/api/auth/login').set('Origin', 'https://site-malicioso.com').set('Access-Control-Request-Method', 'POST');
    expect(pre.status).toBe(403);
  });

  it('JSON inválido → 400, rota desconhecida → 404, corpo grande fora do push → 413', async () => {
    await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{oops').expect(400);
    await request(app).get('/api/nada').expect(404);
    await request(app).post('/api/auth/login').send({ x: 'y'.repeat(20000) }).expect(413);
  });

  it('apagar a conta remove tudo e invalida os tokens', async () => {
    const { token } = await registerAndLogin(app);
    await request(app).delete('/api/auth/account').set(bearer(token)).expect(204);
    await request(app).get('/api/devices').set(bearer(token)).expect(401);
  });
});

describe('Rate limit no login e no cadastro', () => {
  it('bloqueia com 429 depois do limite de tentativas', async () => {
    const { app } = makeApp({ rateLimits: { login: 3, register: 2, api: 1000 } });
    const acc = newAccount();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await login(app, acc)).status);
    expect(codes).toEqual([401, 401, 401, 429]);
    await request(app).post('/api/auth/register').send(newAccount()).expect(201);
    await request(app).post('/api/auth/register').send(newAccount()).expect(201);
    const r = await request(app).post('/api/auth/register').send(newAccount()).expect(429);
    expect(r.body.error).toMatch(/Muitas tentativas/);
  });
});

describe('Aparelhos', () => {
  const { app } = makeApp({ limits: { maxDevicesPerAccount: 3 } });

  it('lista os aparelhos com o atual marcado e renomeia no novo login', async () => {
    const a = await registerAndLogin(app, 'Celular');
    const b = await login(app, a.acc, deviceId(), 'Tablet');
    expect(b.status).toBe(200);
    const again = await login(app, a.acc, b.deviceId, 'Tablet da sala');
    expect(again.status).toBe(200);
    const r = await request(app).get('/api/devices').set(bearer(a.token)).expect(200);
    expect(r.body.devices.map((d: { name: string; current: boolean }) => [d.name, d.current])).toEqual([
      ['Celular', true],
      ['Tablet da sala', false],
    ]);
  });

  it('revogar um aparelho derruba o token dele na hora e impede novo login com o mesmo id', async () => {
    const a = await registerAndLogin(app, 'Celular');
    const b = await login(app, a.acc, deviceId(), 'Tablet');
    await request(app).get('/api/sync/status').set(bearer(b.token)).expect(200);
    await request(app).delete(`/api/devices/${b.deviceId}`).set(bearer(a.token)).expect(204);
    const after = await request(app).get('/api/sync/status').set(bearer(b.token)).expect(401);
    expect(after.body.code).toBe('device_revoked');
    const relog = await login(app, a.acc, b.deviceId, 'Tablet');
    expect(relog.status).toBe(403);
    await request(app).delete(`/api/devices/${b.deviceId}`).set(bearer(a.token)).expect(404);
    await request(app).delete('/api/devices/INVALIDO!').set(bearer(a.token)).expect(400);
  });

  it('limite de aparelhos por conta', async () => {
    const a = await registerAndLogin(app);
    expect((await login(app, a.acc)).status).toBe(200);
    expect((await login(app, a.acc)).status).toBe(200);
    const fourth = await login(app, a.acc);
    expect(fourth.status).toBe(403);
    expect(fourth.body.error).toMatch(/Limite de 3 aparelhos/);
  });

  it('isolamento: um usuário não lista nem revoga aparelhos de outro', async () => {
    const alice = await registerAndLogin(app, 'Celular da Alice');
    const bob = await registerAndLogin(app, 'Celular do Bob');
    const list = await request(app).get('/api/devices').set(bearer(bob.token)).expect(200);
    expect(list.body.devices.map((d: { name: string }) => d.name)).toEqual(['Celular do Bob']);
    await request(app).delete(`/api/devices/${alice.deviceId}`).set(bearer(bob.token)).expect(404);
    await request(app).get('/api/sync/status').set(bearer(alice.token)).expect(200);
  });
});
