// serviço de sincronização (conta, pareamento, aparelhos, offline, revogação), cliente HTTP e tela.
// O servidor é um fake em memória que segue o contrato do backend (backend/README.md), atendido via `fetch`.
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { AppStateProvider } from '../context/AppState';
import { Vault } from '../services/VaultService';
import { Repo, newCredential } from '../services/Repository';
import { AlertService } from '../services/AlertService';
import { bus, Events } from '../services/events';
import { Security } from '../native';
import { VaultDatabase } from '../db/Database';
import { decodePairingCode, deriveSyncAccount } from '../crypto/sync';
import { HybridClock } from '../services/sync/crdt';
import { SyncEngine } from '../services/sync/engine';
import { MSG_HTTPS, MAX_RESPONSE_CHARS, plainHttpWarning, SyncHttpClient, SyncHttpError, validateServerUrl } from '../services/sync/http';
import { SyncService } from '../services/SyncService';
import { SessionService } from '../services/SessionService';
import { ClipboardService } from '../services/ClipboardService';

jest.mock('react-native-vector-icons/Feather', () => 'Icon');
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.setTimeout(120000);

import SyncScreen from '../screens/settings/SyncScreen';

const BASE = 'http://10.0.2.2:3000';
const MASTER = 'Cofre#Seguro2026';

// ---------------------------------------------------------------------------
// Servidor fake com o contrato do backend
// ---------------------------------------------------------------------------
interface FakeDoc {
  collection: string;
  id: string;
  hlc: string;
  ciphertext: string;
  seq: number;
}
interface FakeAccount {
  secret: string;
  seq: number;
  epoch: string;
  docs: Map<string, FakeDoc>;
  devices: Map<string, { name: string; revoked: boolean; lastSeenAt: string }>;
}
type Reply = [number, unknown?];

class FakeBackend {
  accounts = new Map<string, FakeAccount>();
  down = false;
  requests: string[] = [];

  fetch = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    if (this.down) throw new TypeError('Network request failed');
    const [path, query = ''] = url.slice(BASE.length).split('?');
    const method = init.method || 'GET';
    this.requests.push(`${method} ${path}`);
    const body = init.body ? JSON.parse(init.body) : {};
    const token = (init.headers?.Authorization || '').replace('Bearer ', '');
    const [status, json] = this.route(method, path, query, body, token);
    return { ok: status < 300, status, text: async () => (json === undefined ? '' : JSON.stringify(json)) };
  }) as unknown as typeof fetch;

  private authed(token: string): { acc: FakeAccount; deviceId: string } | Reply {
    const [accountId, deviceId] = token.split('.');
    const acc = this.accounts.get(accountId);
    const dev = acc?.devices.get(deviceId);
    if (!acc || !dev || dev.revoked) return [401, { error: 'Este aparelho foi desconectado da conta. Pareie-o novamente.', code: 'device_revoked' }];
    dev.lastSeenAt = new Date().toISOString();
    return { acc, deviceId };
  }

  private route(method: string, path: string, query: string, body: any, token: string): Reply {
    const key = `${method} ${path}`;
    if (key === 'GET /api/health') return [200, { status: 'ok' }];
    if (key === 'POST /api/auth/register') return this.register(body);
    if (key === 'POST /api/auth/login') return this.login(body);
    const auth = this.authed(token);
    if (Array.isArray(auth)) return auth;
    const { acc, deviceId } = auth;
    if (key === 'GET /api/sync/pull') {
      const p = Object.fromEntries(query.split('&').map(kv => kv.split('=')));
      const since = Number(p.since);
      const rows = [...acc.docs.values()].filter(d => d.seq > since).sort((a, b) => a.seq - b.seq);
      const changes = rows.slice(0, Number(p.limit));
      return [200, { changes, cursor: changes.length ? changes[changes.length - 1].seq : since, hasMore: rows.length > changes.length, latest: acc.seq, epoch: acc.epoch }];
    }
    if (key === 'POST /api/sync/push') return this.push(acc, body);
    if (key === 'GET /api/devices') {
      const devices = [...acc.devices.entries()].filter(([, d]) => !d.revoked).map(([id, d]) => ({ id, name: d.name, createdAt: d.lastSeenAt, lastSeenAt: d.lastSeenAt, current: id === deviceId }));
      return [200, { devices }];
    }
    if (method === 'DELETE' && path.startsWith('/api/devices/')) {
      const dev = acc.devices.get(path.slice('/api/devices/'.length));
      if (!dev) return [404, { error: 'Aparelho não encontrado' }];
      dev.revoked = true;
      return [204];
    }
    if (key === 'DELETE /api/auth/account') {
      this.accounts.delete(token.split('.')[0]);
      return [204];
    }
    return [404, { error: 'Rota não encontrada' }];
  }

  private register(body: any): Reply {
    if (this.accounts.has(body.accountId)) return [409, { error: 'Conta já existe' }];
    this.accounts.set(body.accountId, { secret: body.authSecret, seq: 0, epoch: 'ab'.repeat(16), docs: new Map(), devices: new Map() });
    return [201, { accountId: body.accountId }];
  }

  private login(body: any): Reply {
    const acc = this.accounts.get(body.accountId);
    if (!acc || acc.secret !== body.authSecret) return [401, { error: 'Conta não encontrada ou código de pareamento incorreto.' }];
    const dev = acc.devices.get(body.device.id);
    if (dev?.revoked) return [403, { error: 'Este aparelho foi desconectado da conta. Pareie-o novamente.', code: 'device_revoked' }];
    acc.devices.set(body.device.id, { name: body.device.name, revoked: false, lastSeenAt: new Date().toISOString() });
    return [200, { token: `${body.accountId}.${body.device.id}`, expiresIn: 900 }];
  }

  private push(acc: FakeAccount, body: any): Reply {
    const out = { accepted: [] as unknown[], conflicts: [] as unknown[], rejected: [] as unknown[] };
    for (const c of body.changes) {
      const k = `${c.collection}/${c.id}`;
      const current = acc.docs.get(k)?.seq ?? 0;
      if (c.baseSeq !== current) {
        out.conflicts.push({ collection: c.collection, id: c.id, seq: current });
        continue;
      }
      acc.seq += 1;
      acc.docs.set(k, { collection: c.collection, id: c.id, hlc: c.hlc, ciphertext: c.ciphertext, seq: acc.seq });
      out.accepted.push({ collection: c.collection, id: c.id, seq: acc.seq });
    }
    return [200, out];
  }
}

const backend = new FakeBackend();

/** Segundo aparelho (o "tablet"): banco próprio + motor + cliente HTTP, entrando com o código de pareamento. */
async function tablet(code: string) {
  const key = decodePairingCode(code);
  const { accountId, authSecret } = deriveSyncAccount(key);
  const db = new VaultDatabase();
  await db.open('tablet', 'chave-do-tablet');
  const client = new SyncHttpClient(BASE, { accountId, authSecret, device: { id: 'tablet0001', name: 'Tablet' } }, { fetch: backend.fetch });
  await client.login();
  const engine = new SyncEngine(db, client, key, new HybridClock('tablet0001'));
  await engine.init();
  return {
    db,
    client,
    async sync() {
      await engine.reconcile();
      return engine.sync();
    },
  };
}

// ---------------------------------------------------------------------------
// Renderização da tela
// ---------------------------------------------------------------------------
const flush = () => act(async () => new Promise(r => setTimeout(r, 120)));
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

const navigation = { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => () => {}) };

async function render() {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    r = ReactTestRenderer.create(
      <AppStateProvider>
        <SyncScreen navigation={navigation} route={{ params: {}, name: 'Sync' }} />
      </AppStateProvider>,
    );
  });
  mounted.push(r);
  await flush();
  return r;
}

const texts = (r: ReactTestRenderer.ReactTestRenderer) =>
  r.root
    .findAllByType(Text)
    .map(t => (Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')))
    .join(' | ');

const press = async (r: ReactTestRenderer.ReactTestRenderer, title: string) => {
  const n = r.root.findAll(x => typeof x.type !== 'string' && x.props.onPress && (x.props.title === title || x.props.accessibilityLabel === title))[0];
  if (!n) throw new Error(`Botão não encontrado: ${title}`);
  await act(async () => {
    await n.props.onPress();
  });
  await flush();
};

const inputByLabel = (r: ReactTestRenderer.ReactTestRenderer, label: string) =>
  r.root.findAll(n => typeof n.type === 'string' && n.props.onChangeText && n.props.accessibilityLabel === label)[0];

afterEach(async () => {
  while (mounted.length) {
    const r = mounted.pop()!;
    await act(async () => r.unmount());
  }
});

afterAll(async () => {
  SyncService.stop();
  await ClipboardService.clearNow();
  SessionService.stop();
});

// ---------------------------------------------------------------------------
describe('Endereço do servidor', () => {
  it('HTTPS em qualquer lugar; HTTP só no emulador, localhost e rede local (com aviso)', () => {
    expect(validateServerUrl(' https://sync.exemplo.com/ ')).toBe('https://sync.exemplo.com');
    expect(validateServerUrl('http://10.0.2.2:3000')).toBe('http://10.0.2.2:3000');
    expect(validateServerUrl('HTTP://192.168.0.10:3000')).toBe('http://192.168.0.10:3000');
    expect(validateServerUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(validateServerUrl('http://172.20.1.5:3000')).toBe('http://172.20.1.5:3000');
    for (const bad of ['http://exemplo.com', 'http://8.8.8.8:3000', 'http://172.32.0.1', 'http://10.0.2.2.evil.com']) expect(() => validateServerUrl(bad)).toThrow(MSG_HTTPS);
    expect(() => validateServerUrl('')).toThrow('Informe o endereço');
    expect(() => validateServerUrl('ftp://x.com')).toThrow('Endereço inválido');
    expect(() => validateServerUrl('https://user:senha@x.com')).toThrow('Endereço inválido');
    expect(() => validateServerUrl('https://x.com:70000')).toThrow('Porta inválida');
    expect(() => validateServerUrl('https://' + 'a'.repeat(400))).toThrow('longo demais');
    expect(() => validateServerUrl('http://999.1.1.1')).toThrow(MSG_HTTPS);
    expect(plainHttpWarning('http://10.0.2.2:3000')).toMatch(/Conexão sem HTTPS/);
    expect(plainHttpWarning('https://sync.exemplo.com')).toBeNull();
    expect(plainHttpWarning('lixo')).toBeNull();
  });
});

describe('Cliente HTTP: falhas de rede e respostas inválidas viram mensagens claras', () => {
  const creds = { accountId: 'a'.repeat(32), authSecret: 'b'.repeat(64), device: { id: 'device0001', name: 'Celular' } };
  const reply = (status: number, body: string) => (async () => ({ ok: status < 300, status, text: async () => body })) as unknown as typeof fetch;

  it('tempo esgotado e servidor fora do ar', async () => {
    const hang = ((_u: string, init: { signal: AbortSignal }) =>
      new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const c = new SyncHttpClient(BASE, creds, { fetch: hang, timeoutMs: 50 });
    await expect(c.health()).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/não respondeu/) });
    const off = new SyncHttpClient(BASE, creds, { fetch: (async () => Promise.reject(new TypeError('Network request failed'))) as unknown as typeof fetch });
    await expect(off.health()).rejects.toMatchObject({ code: 'network', message: expect.stringMatching(/Não foi possível conectar/) });
  });

  it('não é o servidor do Custódia, 429, 500, resposta fora do formato ou grande demais', async () => {
    await expect(new SyncHttpClient(BASE, creds, { fetch: reply(200, '<html>') }).health()).rejects.toThrow('não é um servidor de sincronização');
    await expect(new SyncHttpClient(BASE, creds, { fetch: reply(200, '{"status":"x"}') }).health()).rejects.toThrow('não é um servidor de sincronização');
    await expect(new SyncHttpClient(BASE, creds, { fetch: reply(429, '{}') }).health()).rejects.toThrow('Muitas tentativas');
    await expect(new SyncHttpClient(BASE, creds, { fetch: reply(503, '{}') }).health()).rejects.toThrow('falhou (erro 503)');
    await expect(new SyncHttpClient(BASE, creds, { fetch: reply(200, 'x'.repeat(MAX_RESPONSE_CHARS + 1)) }).health()).rejects.toThrow('grande demais');
    // Login devolve token; o pull devolve algo fora do contrato
    let n = 0;
    const seq = (async () => {
      n++;
      const body = n === 1 ? '{"token":"t","expiresIn":900}' : '{"changes":[{"collection":1}],"cursor":0,"hasMore":false,"latest":0}';
      return { ok: true, status: 200, text: async () => body };
    }) as unknown as typeof fetch;
    await expect(new SyncHttpClient(BASE, creds, { fetch: seq }).pull(0, 10)).rejects.toThrow('Resposta inválida do servidor');
    expect(() => new SyncHttpClient('http://exemplo.com', creds)).toThrow(MSG_HTTPS);
  });

  it('token expirado: entra de novo uma vez; conta sumida do servidor: recria com a mesma chave', async () => {
    const fake = new FakeBackend();
    const base = { accountId: 'c'.repeat(32), authSecret: 'd'.repeat(64), device: { id: 'device0002', name: 'Celular' } };
    const c = new SyncHttpClient(BASE, base, { fetch: fake.fetch });
    await c.register();
    await expect(c.register()).rejects.toThrow('Esta conta já existe no servidor.');
    await c.pull(0, 10);
    // O servidor "esquece" a conta (banco recriado): o cliente recria a conta e segue
    fake.accounts.clear();
    c.forget();
    expect((await c.pull(0, 10)).latest).toBe(0);
    expect(fake.accounts.size).toBe(1);
    // Segredo errado com a conta existente: não recria, mostra o erro do servidor
    const wrong = new SyncHttpClient(BASE, { ...base, authSecret: 'e'.repeat(64) }, { fetch: fake.fetch });
    await expect(wrong.pull(0, 10)).rejects.toThrow('código de pareamento incorreto');
    await expect(c.revokeDevice('../../x')).rejects.toThrow('Id de aparelho inválido');
  });
});

describe('Sincronização: conta, pareamento e aparelhos', () => {
  let code = '';

  beforeAll(async () => {
    await Vault.createVault({ masterPassword: MASTER });
    SyncService.fetchImpl = backend.fetch;
    SyncService.init();
  });

  it('não conectado: a tela mostra o servidor padrão do emulador, o aviso de HTTP e recusa HTTP fora da rede local', async () => {
    const r = await render();
    expect(Vault.settings.serverUrl).toBe(BASE);
    expect(texts(r)).toContain('Criar conta de sincronização');
    expect(texts(r)).toContain('Conexão sem HTTPS');
    await act(async () => inputByLabel(r, 'Endereço do servidor').props.onChangeText('http://meuservidor.com'));
    await press(r, 'Criar conta de sincronização');
    expect(texts(r)).toContain(MSG_HTTPS);
    expect(backend.accounts.size).toBe(0);
  });

  it('cria a conta pela tela: mostra o código de pareamento, "Sincronizar agora" e os aparelhos', async () => {
    await Repo.saveCredential(newCredential({ title: 'Nubank', username: 'lucas', password: 'Nova#Senha2026!x' }));
    const r = await render();
    await act(async () => inputByLabel(r, 'Nome deste aparelho').props.onChangeText('Celular do Lucas'));
    await press(r, 'Criar conta de sincronização');
    const status = await SyncService.status();
    expect(status.connected).toBe(true);
    expect(status.enabled).toBe(true);
    expect(Vault.settings.syncEnabled).toBe(true);
    const all = texts(r);
    expect(all).toContain('Sincronizar agora');
    expect(all).toContain('Celular do Lucas');
    expect(all).toContain('Este aparelho');
    code = await SyncService.pairingCode();
    expect(all).toContain(code);
    // O servidor recebeu o cofre só cifrado; a chave fica nas preferências cifradas do Keystore
    const acc = [...backend.accounts.values()][0];
    expect(acc.docs.size).toBe(1);
    expect(JSON.stringify([...acc.docs.values()])).not.toMatch(/Nubank|Nova#Senha/);
    expect(await Security.secureGet(`p:${Vault.currentProfile!.id}:syncKey`)).toBeTruthy();
  });

  it('BDD: a senha adicionada no celular aparece no tablet, e a edição do tablet volta para o celular', async () => {
    const t = await tablet(code);
    await t.sync();
    expect((await t.db.all<any>('credentials')).map(c => c.title)).toEqual(['Nubank']);

    const cred = await Repo.saveCredential(newCredential({ title: 'Netflix', username: 'familia', password: 'x9#Lq!v2Tz$8mWp&Rk4e' }));
    await SyncService.syncNow();
    await t.sync();
    const onTablet = await t.db.get<any>('credentials', cred.id);
    expect(onTablet.password).toBe('x9#Lq!v2Tz$8mWp&Rk4e');

    await t.db.put('credentials', { ...onTablet, username: 'familia.marins' });
    await t.sync();
    const changed = jest.fn();
    const off = bus.on(Events.DATA_CHANGED, changed);
    const r = await SyncService.syncNow();
    off();
    expect(r.applied).toBe(1);
    expect(changed).toHaveBeenCalled();
    expect((await Repo.credential(cred.id))!.username).toBe('familia.marins');
    const history = await Repo.versions(cred.id);
    expect(history[0].changeType).toBe('sync');
    expect(history[0].summary).toContain('usuário');
  });

  it('pareamento: código errado e aparelho já conectado dão mensagens claras', async () => {
    await expect(SyncService.pairDevice(BASE, 'AAAA-BBBB')).rejects.toThrow(/tem 56 caracteres/);
    await expect(SyncService.pairDevice(BASE, code)).rejects.toThrow('Este aparelho já está conectado');
  });

  it('offline: a tela mostra "Sem conexão com o servidor" e as alterações ficam pendentes até voltar', async () => {
    backend.down = true;
    await Repo.saveCredential(newCredential({ title: 'Feita offline', password: 'Off#line2026' }));
    const r = await render();
    await press(r, 'Sincronizar agora');
    const status = await SyncService.status();
    expect(status.offline).toBe(true);
    expect(status.pending).toBeGreaterThanOrEqual(1);
    await flush();
    expect(texts(r)).toContain('Sem conexão com o servidor');
    backend.down = false;
    await press(r, 'Sincronizar agora');
    expect((await SyncService.status()).offline).toBe(false);
    expect((await SyncService.status()).pending).toBe(0);
    expect(texts(r)).not.toContain('Sem conexão com o servidor');
  });

  it('aparelhos: lista com o atual marcado; não remove o próprio por "Remover"; remove o outro', async () => {
    const devices = await SyncService.listDevices();
    expect(devices.map(d => d.name).sort()).toEqual(['Celular do Lucas', 'Tablet']);
    const me = devices.find(d => d.current)!;
    await expect(SyncService.revokeDevice(me.id)).rejects.toThrow('Desconectar este aparelho');
    await SyncService.revokeDevice('tablet0001');
    expect((await SyncService.listDevices()).map(d => d.name)).toEqual(['Celular do Lucas']);
  });

  it('ao bloquear o cofre a sincronização para e a chave sai da memória', async () => {
    await Vault.lock();
    await expect(SyncService.syncNow()).rejects.toThrow('Desbloqueie o cofre para sincronizar.');
    const p = (await Vault.getProfile())!;
    await Vault.completeUnlock(p.id, await Vault.verifyPassword(p.id, MASTER), 'password');
    await new Promise(r => setTimeout(r, 200));
    expect((await SyncService.status()).connected).toBe(true);
    await SyncService.syncNow();
  });

  it('aparelho removido por outro: a sincronização desliga aqui, avisa nos alertas e os dados locais ficam', async () => {
    const acc = (await SyncService.getAccount())!;
    [...backend.accounts.values()][0].devices.get(acc.deviceId)!.revoked = true;
    await expect(SyncService.syncNow()).rejects.toThrow('Este aparelho foi desconectado da conta');
    const status = await SyncService.status();
    expect(status.connected).toBe(false);
    expect(Vault.settings.syncEnabled).toBe(false);
    expect((await AlertService.list()).some(a => a.title === 'Aparelho desconectado da sincronização')).toBe(true);
    expect((await Repo.credentials()).length).toBeGreaterThanOrEqual(3);
    expect(await Security.secureGet(`p:${Vault.currentProfile!.id}:syncKey`)).toBeNull();
  });

  it('nova conta e desconexão apagando também do servidor', async () => {
    const before = backend.accounts.size;
    const { pairingCode } = await SyncService.createAccount(BASE, 'Celular');
    expect(pairingCode).toMatch(/^([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/);
    expect(backend.accounts.size).toBe(before + 1);
    await SyncService.disconnect({ deleteServerData: true });
    expect(backend.accounts.size).toBe(before);
    expect((await SyncService.status()).connected).toBe(false);
    await expect(SyncService.syncNow()).rejects.toThrow('não está conectado');
    await expect(SyncService.pairingCode()).rejects.toThrow('não está conectado');
  });

  it('erro de servidor ao criar a conta não grava a chave', async () => {
    backend.down = true;
    await expect(SyncService.createAccount(BASE)).rejects.toBeInstanceOf(SyncHttpError);
    backend.down = false;
    expect(await SyncService.getAccount()).toBeNull();
    expect(await Security.secureGet(`p:${Vault.currentProfile!.id}:syncKey`)).toBeNull();
  });
});
