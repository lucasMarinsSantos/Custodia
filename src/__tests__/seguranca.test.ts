// Segurança: serviços com o banco cifrado (simulado em memória)
//  • vazamentos (HIBP com k-anonimato, cache, verificação manual/automática, offline)
//  • histórico de tentativas de login, alerta e notificação "Tentativa de acesso falha"
import { Vault } from '../services/VaultService';
import { Repo, newCredential } from '../services/Repository';
import { vaultDb } from '../db/Database';
import { Security } from '../native';
import { __setNetMocks } from '../native/net';
import { __sentNotifications } from '../native/notifications';
import { bus, Events } from '../services/events';
import { AlertService } from '../services/AlertService';
import { BREACH_MESSAGE, BreachService, HIBP_RANGE_URL, OFFLINE_MESSAGE, breachText, formatCount, parseRange, sha1Hex } from '../services/BreachService';
import { AccessLogService, FAILED_ATTEMPT_TITLE, MAX_PENDING, MIN_RETENTION_DAYS, RETENTION_DAYS, failureMessage, toEntry } from '../services/AccessLogService';
import { NotificationService, notificationId, safeNotification } from '../services/NotificationService';
import { SecurityMonitor } from '../services/SecurityMonitor';
import { RiskService } from '../services/RiskService';
import { ACCESS_LOG_RETENTION_DAYS, AccessLogEntry, AlertType } from '../types/models';

jest.setTimeout(180000);

const MASTER = 'Cofre#Seguro2026';
const LEAKED = '123456';
const SAFE = 'x9#Lq!v2Tz$8mWp&Rk4e';
const DAY = 86400000;

// ---------------------------------------------------------------------------
// API do HIBP simulada: devolve o sufixo da senha vazada e linhas de preenchimento (contagem 0)
// ---------------------------------------------------------------------------
const leakedHash = sha1Hex(LEAKED);
const requests: { url: string; init: any }[] = [];
let fetchMode: 'ok' | 'offline' | 'error' | 'huge' = 'ok';

function rangeBody(prefix: string): string {
  const lines = ['0018A45C4D1DEF81644B54AB7F969B88D65:1', '00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2'];
  if (prefix === leakedHash.slice(0, 5)) lines.push(`${leakedHash.slice(5)}:37359195`);
  // preenchimento do Add-Padding e lixo que deve ser ignorado
  lines.push('011053FD0102E94D6AE2F8B83D76FAF94F6:0', 'linha malformada', `${SAFE}:5`);
  return lines.join('\r\n');
}

(global as any).fetch = jest.fn(async (url: string, init: any) => {
  requests.push({ url, init });
  if (fetchMode === 'offline') throw new TypeError('Network request failed');
  if (fetchMode === 'error') return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' };
  const prefix = url.slice(HIBP_RANGE_URL.length);
  const body = fetchMode === 'huge' ? 'A'.repeat(2 * 1024 * 1024) : rangeBody(prefix);
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
});

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

async function unlock(password = MASTER) {
  const p = (await Vault.getProfile())!;
  const dek = await Vault.verifyPassword(p.id, password);
  await Vault.completeUnlock(p.id, dek, 'password');
  return p;
}

beforeAll(async () => {
  SecurityMonitor.init();
  await Vault.createVault({ masterPassword: MASTER });
});

afterAll(() => {
  SecurityMonitor._reset();
});

beforeEach(() => {
  requests.length = 0;
  fetchMode = 'ok';
  BreachService.clearMemory();
});

describe(': vazamentos via Have I Been Pwned (k-anonimato)', () => {
  it('lê a resposta da API: ignora o preenchimento, linhas malformadas e respostas grandes demais', () => {
    const m = parseRange(rangeBody(leakedHash.slice(0, 5)));
    expect(m.get(leakedHash.slice(5))).toBe(37359195);
    expect([...m.values()].every(n => n > 0)).toBe(true);
    expect(m.size).toBe(3);
    expect(() => parseRange('A'.repeat(2 * 1024 * 1024))).toThrow('Resposta inesperada');
    expect(formatCount(37359195)).toBe('37.359.195');
    expect(breachText(1)).toBe('encontrada 1 vez');
  });

  it('BDD "Senha comprometida detectada": alerta vermelho "Esta senha já apareceu em vazamentos de dados"', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'Fórum antigo', username: 'lucas', password: LEAKED }));
    const r = await BreachService.checkCredential(c);
    expect(r.count).toBe(37359195);
    // Só os 5 primeiros caracteres do SHA-1 saem do aparelho, com o cabeçalho Add-Padding
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(HIBP_RANGE_URL + leakedHash.slice(0, 5));
    expect(requests[0].url).toMatch(/^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/);
    expect(requests[0].init.headers['Add-Padding']).toBe('true');
    const sent = JSON.stringify(requests);
    expect(sent).not.toContain(LEAKED);
    expect(sent).not.toContain(leakedHash.slice(5));
    expect(sent).not.toContain('lucas');
    const alert = (await AlertService.list()).find(a => a.type === 'breach' && a.ref === c.id)!;
    expect(alert.severity).toBe('danger');
    expect(alert.message).toContain(BREACH_MESSAGE);
    expect((await BreachService.status(c)).state).toBe('pwned');
  });

  it('BDD "Verificação de senha segura": senha gerada e nunca vazada fica marcada como segura', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'Banco', password: SAFE }));
    expect((await BreachService.status(c)).state).toBe('unknown');
    expect((await BreachService.checkCredential(c)).count).toBe(0);
    expect(await BreachService.status(c)).toMatchObject({ state: 'safe', count: 0 });
  });

  it('cache: não consulta de novo enquanto a senha não muda; a troca da senha invalida o resultado', async () => {
    const c = await Repo.saveCredential(newCredential({ title: 'Cache', password: LEAKED }));
    await BreachService.checkCredential(c, { alert: false });
    BreachService.clearMemory();
    requests.length = 0;
    const again = await BreachService.checkCredential(c);
    expect(again.cached).toBe(true);
    expect(requests).toHaveLength(0);
    // O cache guardado no banco não tem a senha nem o hash completo
    const raw = (await vaultDb.getKv('breachCache'))!;
    expect(raw).not.toContain(LEAKED);
    expect(raw).not.toContain(leakedHash);
    await tick(5);
    const changed = await Repo.saveCredential({ ...c, password: SAFE });
    expect((await BreachService.status(changed)).state).toBe('unknown');
    expect((await BreachService.checkCredential(changed)).cached).toBe(false);
    expect(await BreachService.status(changed)).toMatchObject({ state: 'safe' });
  });

  it('verificação manual de todo o cofre: um download por prefixo e relatório com as contas comprometidas', async () => {
    const run = await BreachService.checkAll(await Repo.credentials(), undefined, { force: true });
    expect(run.offline).toBe(false);
    expect(run.pwned).toBeGreaterThanOrEqual(1);
    expect(run.results.find(r => r.title === 'Fórum antigo')!.count).toBe(37359195);
    const prefixes = requests.map(r => r.url);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(await BreachService.isDue()).toBe(false);
    expect(await BreachService.isDue(Date.now() + 8 * DAY)).toBe(true);
    // o risco usa o resultado do vazamento
    const creds = await Repo.credentials();
    const ranked = RiskService.rank(creds, RiskService.context(creds, { maxAgeDays: 90 }));
    expect(ranked[0].risk.factors.some(f => f.key === 'breach')).toBe(true);
  });

  it('offline não quebra: devolve o que estava no cache e avisa', async () => {
    fetchMode = 'offline';
    const before = await BreachService.lastRun();
    const creds = await Repo.credentials();
    const fresh = await Repo.saveCredential(newCredential({ title: 'Nova offline', password: 'Ou7r@Senha#Nova' }));
    await BreachService.load();
    const run = await BreachService.checkAll([...creds, fresh], undefined, { force: true });
    expect(run.offline).toBe(true);
    expect(run.error).toBe(OFFLINE_MESSAGE);
    expect(run.results.some(r => r.title === 'Fórum antigo' && r.cached)).toBe(true);
    expect(run.results.some(r => r.title === 'Nova offline')).toBe(false);
    expect(await BreachService.lastRun()).toBe(before);
    await expect(BreachService.checkCredential(fresh)).rejects.toThrow(OFFLINE_MESSAGE);
    // aparelho sem rede: nem tenta a conexão
    fetchMode = 'ok';
    __setNetMocks({ network: { connected: false, type: 'none' } });
    requests.length = 0;
    await expect(BreachService.pwnedCount('qualquer')).rejects.toThrow(OFFLINE_MESSAGE);
    expect(requests).toHaveLength(0);
    __setNetMocks({ network: null });
  });

  it('erro do servidor e resposta gigante viram mensagem para o usuário, sem travar', async () => {
    fetchMode = 'error';
    const run = await BreachService.checkAll(await Repo.credentials(), undefined, { force: true });
    expect(run.error).toContain('503');
    fetchMode = 'huge';
    await expect(BreachService.pwnedCount('outra senha')).rejects.toThrow('Resposta inesperada');
  });

  it('verificação automática ao salvar (ligada por padrão) e limpeza do cache ao excluir', async () => {
    expect(Vault.settings.breachAutoCheck).toBe(true);
    SecurityMonitor._reset();
    const c = await Repo.saveCredential(newCredential({ title: 'Automática', password: LEAKED }));
    const n = await SecurityMonitor.runAutoChecks();
    expect(n).toBe(1);
    expect((await BreachService.status(c)).state).toBe('pwned');
    await Repo.deleteCredential(c.id);
    await tick();
    expect(Object.keys(await BreachService.load())).not.toContain(c.id);
    // desligada: não consulta
    await Vault.updateSettings({ breachAutoCheck: false });
    await Repo.saveCredential(newCredential({ title: 'Sem automática', password: 'Mais#Uma2026xx' }));
    requests.length = 0;
    expect(await SecurityMonitor.runAutoChecks()).toBe(0);
    expect(await SecurityMonitor.runPeriodic()).toBe(false);
    expect(requests).toHaveLength(0);
    await Vault.updateSettings({ breachAutoCheck: true });
    SecurityMonitor._reset();
  });
});

describe(': histórico de tentativas de login e alertas', () => {
  it('retenção de no mínimo 30 dias', () => {
    expect(ACCESS_LOG_RETENTION_DAYS).toBeGreaterThanOrEqual(30);
    expect(RETENTION_DAYS).toBeGreaterThanOrEqual(MIN_RETENTION_DAYS);
    expect(failureMessage(1)).toBe('1 tentativa de acesso falhou desde o último acesso');
  });

  it('não confia no evento: método inválido, perfil inválido e detalhe enorme', async () => {
    expect(toEntry({ profileId: 'x', method: 'hack' as any, success: true, at: '' }, '')).toBeNull();
    const e = toEntry({ profileId: 'x', method: 'password', success: false, detail: 'a'.repeat(5000), at: 'lixo' }, 'Aparelho')!;
    expect(e.detail!.length).toBeLessThanOrEqual(120);
    expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    await AccessLogService.record({ profileId: '../../etc', method: 'password', success: false, at: new Date().toISOString() });
    expect(await Security.secureKeys('p:../')).toEqual([]);
  });

  it('com o cofre fechado, a falha vai para a fila cifrada e gera a notificação "Tentativa de acesso falha" com data e hora', async () => {
    const p = (await Vault.getProfile())!;
    await Vault.lock();
    __sentNotifications().length = 0;
    await expect(Vault.verifyPassword(p.id, 'senha-errada-123')).rejects.toThrow('Senha mestra incorreta');
    await AccessLogService.idle();
    await tick();
    const queue = JSON.parse((await Security.secureGet(`p:${p.id}:pendingAccess`))!);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]).toMatchObject({ method: 'password', success: false, detail: 'Senha mestra incorreta' });
    expect(JSON.stringify(queue)).not.toContain('senha-errada-123');
    const n = __sentNotifications().pop()!;
    expect(n.title).toBe(FAILED_ATTEMPT_TITLE);
    expect(n.body).toMatch(/^Em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(Senha mestra\)\./);
    expect(n.id).toBe(notificationId('login_failed'));

    // segunda falha: a notificação conta as falhas seguidas
    await expect(Vault.verifyPassword(p.id, 'outra-errada-456')).rejects.toThrow();
    await AccessLogService.idle();
    await tick();
    expect(__sentNotifications().pop()!.body).toContain('2 falhas seguidas');
  });

  it('no desbloqueio: o histórico vai para o banco, aparece o aviso e o alerta "Tentativa de acesso falha em <data>"', async () => {
    const toasts: any[] = [];
    const off = bus.on(Events.TOAST, t => toasts.push(t));
    const p = await unlock();
    // Sem o AppController neste teste: simula o fim da verificação de integridade do desbloqueio
    bus.emit(Events.INTEGRITY_CHECKED);
    await tick(50);
    await AccessLogService.idle();
    off();
    const p2 = (await Vault.getProfile())!;
    expect(p2.id).toBe(p.id);
    expect(await Security.secureGet(`p:${p.id}:pendingAccess`)).toBeNull();
    const log = await AccessLogService.list();
    expect(log.slice(0, 3).map(e => e.success)).toEqual([true, false, false]);
    expect(log[0].device).toBeTruthy();
    expect((await AccessLogService.list({ onlyFailures: true })).every(e => !e.success)).toBe(true);
    expect(toasts).toContainEqual({ message: '2 tentativas de acesso falharam desde o último acesso', kind: 'error' });
    const alert = (await AlertService.list()).find(a => a.type === 'login_failed')!;
    expect(alert.title).toMatch(/^Tentativa de acesso falha em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(alert.read).toBe(false);
  });

  it('falha com o cofre aberto (reautenticação) também gera alerta e notificação', async () => {
    const p = (await Vault.getProfile())!;
    __sentNotifications().length = 0;
    // Um alerta igual não lido no mesmo minuto não se repete (AlertService); lidos, o novo aparece
    await AlertService.markRead();
    const before = (await AlertService.list()).length;
    await expect(Vault.verifyPassword(p.id, 'reauth-errada')).rejects.toThrow();
    await AccessLogService.idle();
    await tick();
    expect((await AlertService.list()).length).toBe(before + 1);
    expect(__sentNotifications().pop()!.title).toBe(FAILED_ATTEMPT_TITLE);
    // Notificações desligadas nos ajustes: nada na barra do sistema
    await Vault.updateSettings({ securityNotifications: false });
    await expect(Vault.verifyPassword(p.id, 'reauth-errada-2')).rejects.toThrow();
    await AccessLogService.idle();
    await tick();
    expect(__sentNotifications()).toHaveLength(0);
    await Vault.updateSettings({ securityNotifications: true });
    await Vault.verifyPassword(p.id, MASTER); // zera o contador de falhas
  });

  it('central de alertas: lidos e não lidos', async () => {
    const unread = await AlertService.unreadCount();
    expect(unread).toBeGreaterThan(0);
    const first = (await AlertService.list())[0];
    await AlertService.markRead(first.id);
    expect(await AlertService.unreadCount()).toBe(unread - 1);
    await AlertService.markRead();
    expect(await AlertService.unreadCount()).toBe(0);
  });

  it('apaga o que passou da retenção e limita a fila com o cofre fechado', async () => {
    const old: AccessLogEntry = { id: 'velha', at: new Date(Date.now() - (RETENTION_DAYS + 1) * DAY).toISOString(), method: 'password', success: true };
    const recent: AccessLogEntry = { id: 'recente', at: new Date(Date.now() - 29 * DAY).toISOString(), method: 'biometric', success: true };
    await vaultDb.put('accessLog', old, { silent: true });
    await vaultDb.put('accessLog', recent, { silent: true });
    expect((await AccessLogService.list()).some(e => e.id === 'velha')).toBe(false);
    const p = (await Vault.getProfile())!;
    await AccessLogService.flush(p.id);
    expect(await vaultDb.get('accessLog', 'velha')).toBeNull();
    expect(await vaultDb.get('accessLog', 'recente')).not.toBeNull();

    // Fila: um atacante insistente não enche o armazenamento, e as falhas descartadas continuam contando
    const fake = 'perfil-de-teste';
    for (let i = 0; i < MAX_PENDING + 5; i++) await AccessLogService.record({ profileId: fake, method: 'password', success: false, at: new Date().toISOString() });
    const q = JSON.parse((await Security.secureGet(`p:${fake}:pendingAccess`))!);
    expect(q.entries).toHaveLength(MAX_PENDING);
    expect(q.droppedFailures).toBe(5);
    expect(await AccessLogService.pendingFailures(fake)).toBe(MAX_PENDING);
  });

  it('as notificações nunca levam dados do cofre', async () => {
    const types: AlertType[] = ['login_failed', 'breach', 'weak', 'reused', 'old', 'expired', 'phishing', 'ssl', 'integrity', 'backup', 'sync', 'policy', 'new_device'];
    for (const t of types) expect(safeNotification(t).title.length).toBeGreaterThan(3);
    __sentNotifications().length = 0;
    await AlertService.raise({ type: 'breach', severity: 'danger', title: 'Senha vazada: Banco Secreto', message: 'usuario lucas', ref: 'x1' });
    await tick();
    const n = __sentNotifications().pop()!;
    expect(n.title).toBe('Senha encontrada em vazamento');
    expect(`${n.title} ${n.body}`).not.toMatch(/Banco Secreto|lucas/);
    expect(await NotificationService.notifyAlert({ type: 'ssl' })).toBe(true);
  });
});
