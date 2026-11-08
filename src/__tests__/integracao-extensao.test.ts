// conectar o app à extensão do navegador.
// O lado da extensão é o código real de `browser-extension/protocol.js` (Web Crypto do Node); o lado do app é o
// BrowserBridgeService com o banco em memória. O HTTP do Kotlin é simulado pelos eventos `http` e pelas respostas
// guardadas no fallback em memória do módulo nativo.
import { Vault } from '../services/VaultService';
import { Repo, newCredential, newFolder } from '../services/Repository';
import { APPROVAL_EVENT, BRIDGE_MSG, BridgeApprovals, BrowserBridgeService, MAX_PAIR_ATTEMPTS, sanitizeName } from '../services/BrowserBridgeService';
import { ReplayGuard, open, seal, pairingCode, commitment, ProtocolError, b64Exact } from '../services/BridgeProtocol';
import { __integrationMocks } from '../native/integration';
import { bus } from '../services/events';
import { fromB64, randomBytes } from '../crypto';

jest.setTimeout(120000);

const P = require('../../browser-extension/protocol.js');
const MASTER = 'Cofre#Seguro2026';
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

let seq = 0;
/** Simula uma requisição HTTP que o Kotlin repassou ao JS. */
async function http(path: string, body?: object | string, method: 'GET' | 'POST' = 'POST') {
  const requestId = `r${++seq}`;
  await BrowserBridgeService.handleEvent({ type: 'http', requestId, method, path, body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) });
  const res = __integrationMocks.bridge.responses.get(requestId)!;
  return { status: res.status, body: JSON.parse(res.body) };
}

/** Responde à próxima confirmação que aparecer no celular. */
function answerNext(allow: boolean, seen?: (a: any) => void) {
  const off = bus.on(APPROVAL_EVENT, () => {
    const a = BridgeApprovals.pending()[0];
    if (!a) return;
    off();
    seen?.(a);
    setTimeout(() => BridgeApprovals.answer(a.id, allow), 5);
  });
}

/** Pareamento completo do lado da extensão, com a confirmação no celular. */
async function pairExtension(allow = true, name = 'Chrome no Windows') {
  const { state, message } = await P.beginPairing(name);
  const start = await http('/v1/pair/start', message);
  expect(start.status).toBe(200);
  const { code, message: finish } = await P.codeFor(state, start.body);
  let phoneCode = '';
  answerNext(allow, a => (phoneCode = a.code));
  const res = await http('/v1/pair/finish', finish);
  return { res, code, phoneCode, state };
}

async function rpc(session: any, payload: object) {
  const { nonce, body } = await P.sealRequest(session, payload);
  const res = await http('/v1/rpc', body);
  if (res.status !== 200) return { status: res.status, body: res.body };
  return { status: 200, body: await P.openResponse(session, res.body, nonce), raw: body };
}

beforeAll(async () => {
  await Vault.createVault({ masterPassword: MASTER });
  await Vault.updateSettings({ browserBridge: true });
  await BrowserBridgeService.sync();
});

describe('Protocolo (funções puras)', () => {
  it('o código de 6 dígitos e o compromisso são iguais nos dois lados (app e extensão)', async () => {
    const pkE = new Uint8Array(65).fill(4);
    const pkP = new Uint8Array(65).fill(7);
    const nE = randomBytes(16);
    const nP = randomBytes(16);
    expect(await P.pairingCode(pkE, pkP, nE, nP)).toBe(pairingCode(pkE, pkP, nE, nP));
    expect(Array.from(await P.commitment(pkE, nE))).toEqual(Array.from(commitment(pkE, nE)));
    expect(pairingCode(pkE, pkP, nE, nP)).toMatch(/^\d{6}$/);
  });

  it('o envelope só abre com a mesma chave, sessão e direção', () => {
    const key = randomBytes(32);
    const env = seal(key, 'sessao-1234', 'req', { op: 'ping' });
    expect(open(key, 'sessao-1234', 'req', env)).toEqual({ op: 'ping' });
    expect(() => open(key, 'sessao-1234', 'res', env)).toThrow('Mensagem não autenticada');
    expect(() => open(key, 'outra-sessao', 'req', env)).toThrow(ProtocolError);
    expect(() => open(randomBytes(32), 'sessao-1234', 'req', env)).toThrow(ProtocolError);
    const bytes = fromB64(env.ct);
    bytes[0] = bytes[0] === 0 ? 1 : 0;
    expect(() => open(key, 'sessao-1234', 'req', { ...env, ct: Buffer.from(bytes).toString('base64') })).toThrow(ProtocolError);
    expect(() => b64Exact('AAAA', 32, 'Chave')).toThrow('Chave inválido');
  });

  it('anti-replay: recusa nonce repetido e horário fora de ±60 s', () => {
    const g = new ReplayGuard();
    const now = Date.now();
    expect(g.accept('s', 'nonce-0123456789ab', now, now)).toBe(true);
    expect(g.accept('s', 'nonce-0123456789ab', now, now)).toBe(false);
    expect(g.accept('s', 'nonce-0123456789cd', now - 61_000, now)).toBe(false);
    expect(g.accept('s', 'curto', now, now)).toBe(false);
  });

  it('o nome da extensão vindo da rede é limpo e curto', () => {
    expect(sanitizeName('<script>alert(1)</script> Chrome')).toBe('scriptalert(1)script Chrome');
    expect(sanitizeName('x'.repeat(500))).toHaveLength(40);
    expect(sanitizeName(null)).toBe('Navegador');
  });
});

describe('Pareamento pelo celular', () => {
  it('sem tocar em "Parear nova extensão" no celular, nenhum pareamento é aceito', async () => {
    const { message } = await P.beginPairing('Intruso');
    const res = await http('/v1/pair/start', message);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(BRIDGE_MSG.notPairing);
  });

  it('pareia: os dois lados mostram o mesmo código, o app prova a chave e a sessão fica no cofre', async () => {
    await BrowserBridgeService.startPairing();
    const { res, code, phoneCode, state } = await pairExtension(true);
    expect(res.status).toBe(200);
    expect(phoneCode).toBe(`${code.slice(0, 3)} ${code.slice(3)}`);
    const session = await P.finishPairing(state, res.body);
    const sessions = await BrowserBridgeService.publicSessions();
    expect(sessions[0].name).toBe('Chrome no Windows');
    expect(JSON.stringify(sessions)).not.toContain('"key"');
    const ping = await rpc(session, { op: 'ping' });
    expect(ping.body).toMatchObject({ ok: true, name: 'Chrome no Windows' });
    // A janela de pareamento fecha depois do uso
    expect(BrowserBridgeService.pairingWindow).toBeNull();
  });

  it('a extensão recusa uma resposta de pareamento sem a prova da chave', async () => {
    await BrowserBridgeService.startPairing();
    const { res, state } = await pairExtension(true, 'Firefox');
    await expect(P.finishPairing(state, { ...res.body, proof: Buffer.from(randomBytes(32)).toString('base64') })).rejects.toThrow('O app não comprovou a chave');
  });

  it('pareamento negado no celular não cria sessão', async () => {
    const before = (await BrowserBridgeService.sessions()).length;
    await BrowserBridgeService.startPairing();
    const { res } = await pairExtension(false, 'Edge');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(BRIDGE_MSG.pairingDenied);
    expect((await BrowserBridgeService.sessions()).length).toBe(before);
  });

  it('a chave revelada precisa bater com o compromisso (o atacante não troca a chave depois)', async () => {
    await BrowserBridgeService.startPairing();
    const a = await P.beginPairing('Extensão');
    const start = await http('/v1/pair/start', a.message);
    const { message: finish } = await P.codeFor(a.state, start.body);
    const other = await P.beginPairing('Atacante');
    const res = await http('/v1/pair/finish', { ...finish, pk: P.b64(other.state.pk) });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(BRIDGE_MSG.badCommit);
  });

  it('um intermediário que troca a chave do app faz os códigos ficarem diferentes', async () => {
    await BrowserBridgeService.startPairing();
    const ext = await P.beginPairing('Vítima');
    const start = await http('/v1/pair/start', ext.message);
    // O atacante responde à extensão com a chave dele no lugar da do app
    const mitm = await P.beginPairing('Atacante');
    const forged = { ...start.body, pk: P.b64(mitm.state.pk) };
    const { code: extCode } = await P.codeFor(ext.state, forged);
    const realCode = pairingCode(ext.state.pk, fromB64(start.body.pk), ext.state.nonce, fromB64(start.body.nonce));
    expect(extCode).not.toBe(realCode);
    BrowserBridgeService.cancelPairing();
  });

  it(`limita a ${MAX_PAIR_ATTEMPTS} tentativas por janela de pareamento`, async () => {
    await BrowserBridgeService.startPairing();
    let last = 0;
    for (let i = 0; i <= MAX_PAIR_ATTEMPTS; i++) last = (await http('/v1/pair/start', (await P.beginPairing('x')).message)).status;
    expect(last).toBe(429);
    expect(BrowserBridgeService.pairingWindow).toBeNull();
  });
});

describe('Pedidos da extensão pareada', () => {
  let session: any;
  let siteId = '';
  let blockedId = '';

  beforeAll(async () => {
    await BrowserBridgeService.startPairing();
    const { res, state } = await pairExtension(true, 'Chrome do trabalho');
    session = await P.finishPairing(state, res.body);
    const site = await Repo.saveCredential(newCredential({ title: 'Empresa', username: 'lucas', password: 'Senha#Forte2026!', url: 'https://empresa.com.br' }));
    siteId = site.id;
    await Repo.saveCredential(newCredential({ title: 'Antiga', username: 'velho', password: 'x', url: 'https://empresa.com.br', inactive: true }));
    const folder = newFolder('Bloqueada');
    folder.policy = { blockAutofill: true } as any;
    await Repo.saveFolder(folder);
    blockedId = (await Repo.saveCredential(newCredential({ title: 'Banco', username: 'b', password: 'p', url: 'https://empresa.com.br', folderId: folder.id }))).id;
  });

  it('lista os logins do site sem senhas e sem credenciais inativas ou de pasta bloqueada', async () => {
    const r = await rpc(session, { op: 'list', url: 'https://login.empresa.com.br/entrar' });
    expect(r.body.items.map((i: any) => i.title)).toEqual(['Empresa']);
    expect(JSON.stringify(r.body)).not.toContain('Senha#Forte2026!');
  });

  it('não lista nada num site parecido (phishing)', async () => {
    const r = await rpc(session, { op: 'list', url: 'https://ernpresa.com.br/login' });
    expect(r.body.code).toBe('phishing');
    expect(r.body.items).toBeUndefined();
  });

  it('a senha só sai com "Permitir" no celular e conta como uso', async () => {
    answerNext(false);
    const denied = await rpc(session, { op: 'get', url: 'https://empresa.com.br', credentialId: siteId });
    expect(denied.body.error).toBe(BRIDGE_MSG.denied);
    let message = '';
    answerNext(true, a => (message = a.message));
    const allowed = await rpc(session, { op: 'get', url: 'https://empresa.com.br', credentialId: siteId });
    expect(message).toContain('Empresa');
    expect(allowed.body.password).toBe('Senha#Forte2026!');
    expect((await Repo.credential(siteId))!.usageCount).toBe(1);
  });

  it('não enfileira um segundo pedido de senha enquanto o primeiro espera no celular', async () => {
    const first = rpc(session, { op: 'get', url: 'https://empresa.com.br', credentialId: siteId });
    await tick(30);
    const second = await rpc(session, { op: 'get', url: 'https://empresa.com.br', credentialId: siteId });
    expect(second.body.code).toBe('busy');
    BridgeApprovals.answer(BridgeApprovals.pending()[0].id, false);
    expect((await first).body.code).toBe('denied');
  });

  it('recusa senha de outro site e de pasta com preenchimento bloqueado, sem perguntar ao celular', async () => {
    const other = await rpc(session, { op: 'get', url: 'https://outro.com', credentialId: siteId });
    expect(other.body.code).toBe('nomatch');
    const blocked = await rpc(session, { op: 'get', url: 'https://empresa.com.br', credentialId: blockedId });
    expect(blocked.body.code).toBe('credential');
    expect(BridgeApprovals.pending()).toHaveLength(0);
  });

  it('recusa pedido alterado, repetido, com relógio fora da janela ou de sessão desconhecida', async () => {
    const { body } = await P.sealRequest(session, { op: 'ping' });
    expect((await http('/v1/rpc', body)).status).toBe(200);
    const replayed = await http('/v1/rpc', body);
    expect(replayed.body.code).toBe('replay');
    const ct = fromB64(body.ct);
    ct[3] = ct[3] === 0 ? 1 : 0;
    expect((await http('/v1/rpc', { ...body, ct: Buffer.from(ct).toString('base64') })).body.code).toBe('auth');
    const old = await P.sealRequest(session, { op: 'ping' });
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60_000;
    try {
      expect((await http('/v1/rpc', old.body)).body.code).toBe('clock');
    } finally {
      Date.now = realNow;
    }
    expect((await http('/v1/rpc', { ...body, sid: 'nao-existe-123' })).status).toBe(401);
  });

  it('a resposta é amarrada ao pedido (a extensão recusa resposta de outro pedido)', async () => {
    const a = await P.sealRequest(session, { op: 'ping' });
    const resA = await http('/v1/rpc', a.body);
    await expect(P.openResponse(session, resA.body, 'outro-nonce')).rejects.toThrow('Resposta não corresponde ao pedido.');
  });

  it('rotas desconhecidas, JSON inválido e corpo grande demais são recusados', async () => {
    expect((await http('/v1/status', undefined, 'GET')).body).toMatchObject({ app: 'Custódia', v: 1 });
    expect((await http('/v1/qualquer', {})).status).toBe(404);
    expect((await http('/v1/rpc', '{nao é json')).status).toBe(400);
    expect((await http('/v1/pair/start', 'x'.repeat(70 * 1024))).status).toBe(400);
  });

  it('a extensão pode se desconectar (revoga a sessão no celular)', async () => {
    expect((await rpc(session, { op: 'revoke' })).body.ok).toBe(true);
    const after = await rpc(session, { op: 'ping' });
    expect(after.status).toBe(401);
    expect(after.body.error).toBe(BRIDGE_MSG.session);
  });
});

describe('Ciclo de vida da ponte', () => {
  it('revogar no celular invalida a sessão', async () => {
    await BrowserBridgeService.startPairing();
    const { res, state } = await pairExtension(true, 'Para revogar');
    const session = await P.finishPairing(state, res.body);
    await BrowserBridgeService.revoke(session.sid);
    expect((await rpc(session, { op: 'ping' })).status).toBe(401);
  });

  it('ao bloquear o cofre a ponte fecha e as confirmações abertas viram "Negar"', async () => {
    const pending = BridgeApprovals.request({ kind: 'password', title: 't', message: 'm' });
    await BrowserBridgeService.stop();
    expect(await pending).toBe(false);
    expect(__integrationMocks.bridge.running).toBe(false);
  });

  it('desligada nos Ajustes, a ponte responde 423 e não abre', async () => {
    await BrowserBridgeService.setEnabled(false);
    expect(__integrationMocks.bridge.running).toBe(false);
    const r = await http('/v1/rpc', {});
    expect(r.status).toBe(423);
    await expect(BrowserBridgeService.startPairing()).rejects.toThrow(BRIDGE_MSG.disabled);
  });

  it('porta ocupada vira mensagem clara', async () => {
    __integrationMocks.bridge.failStart = true;
    try {
      await expect(BrowserBridgeService.setEnabled(true)).rejects.toThrow(BRIDGE_MSG.portBusy);
    } finally {
      __integrationMocks.bridge.failStart = false;
    }
    await BrowserBridgeService.sync();
    expect(__integrationMocks.bridge.running).toBe(true);
  });

  it('modo rede Wi-Fi reabre o servidor fora do loopback', async () => {
    await BrowserBridgeService.setLan(true);
    expect(__integrationMocks.bridge.lan).toBe(true);
    expect(await BrowserBridgeService.addresses()).toEqual(['192.168.0.10']);
    await BrowserBridgeService.setLan(false);
    expect(__integrationMocks.bridge.lan).toBe(false);
    await tick();
  });
});
