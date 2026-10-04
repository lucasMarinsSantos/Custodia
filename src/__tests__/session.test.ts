// Bloqueio automático (inatividade, minimizar) e limpeza da área de transferência
import { AppState } from 'react-native';
import { Vault } from '../services/VaultService';
import { SessionService } from '../services/SessionService';
import { ClipboardService, CLIPBOARD_EVENT } from '../services/ClipboardService';
import { System } from '../native';
import { bus, Events } from '../services/events';

jest.setTimeout(60000);

const MASTER = 'Sessao#Segura2026';
let profileId = '';

async function unlockReal() {
  const dek = await Vault.verifyPassword(profileId, MASTER);
  await Vault.completeUnlock(profileId, dek, 'password');
}

/** Captura o último ouvinte registrado em AppState.addEventListener('change', …) (mock do jest-preset). */
function lastAppStateListener(): (s: string) => void {
  const calls = (AppState.addEventListener as jest.Mock).mock.calls.filter(c => c[0] === 'change');
  return calls[calls.length - 1][1];
}

beforeAll(async () => {
  const r = await Vault.createVault({ masterPassword: MASTER });
  profileId = r.profile.id;
});

afterEach(() => {
  jest.useRealTimers();
  SessionService.stop();
});

describe('Bloqueio automático', () => {
  it('BDD: bloqueia após 5 minutos de inatividade e qualquer interação reinicia o contador', async () => {
    if (!Vault.isUnlocked) await unlockReal();
    expect(Vault.settings.autoLockMinutes).toBe(5);
    const reasons: string[] = [];
    const off = bus.on(Events.LOCKED, r => reasons.push(r));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    SessionService.start();
    jest.advanceTimersByTime(3 * 60 * 1000);
    SessionService.activity(); // toque do usuário aos 3 min
    jest.advanceTimersByTime(4 * 60 * 1000);
    expect(Vault.isUnlocked).toBe(true); // 7 min desde o início, mas só 4 desde o último toque
    jest.advanceTimersByTime(61 * 1000);
    expect(Vault.isUnlocked).toBe(false);
    expect(reasons).toEqual(['inatividade']);
    off();
  });

  it('avisa 15 s antes do bloqueio e digitar conta como atividade', async () => {
    if (!Vault.isUnlocked) await unlockReal();
    const toasts: any[] = [];
    const off = bus.on(Events.TOAST, t => toasts.push(t));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    SessionService.start();
    jest.advanceTimersByTime(5 * 60 * 1000 - 15 * 1000);
    expect(toasts.some(t => /bloqueado em 15 s/.test(t.message))).toBe(true);
    bus.emit(Events.ACTIVITY); // o usuário digitou em um campo
    jest.advanceTimersByTime(60 * 1000);
    expect(Vault.isUnlocked).toBe(true);
    SessionService.holdInactivity(true); // ex.: tela do código de recuperação aberta
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(Vault.isUnlocked).toBe(true);
    SessionService.holdInactivity(false);
    jest.advanceTimersByTime(5 * 60 * 1000 + 1000);
    expect(Vault.isUnlocked).toBe(false);
    off();
  });

  it('BDD: ao voltar do segundo plano após o período configurado, exige autenticação', async () => {
    jest.useRealTimers();
    await unlockReal();
    SessionService.start();
    const listener = lastAppStateListener();
    const now = Date.now;
    listener('background');
    Date.now = () => now() + 6 * 60 * 1000;
    try {
      listener('active');
    } finally {
      Date.now = now;
    }
    expect(Vault.isUnlocked).toBe(false);
  });

  it('atrasar o relógio com o app em segundo plano não evita a reautenticação', async () => {
    jest.useRealTimers();
    await unlockReal();
    SessionService.start();
    const listener = lastAppStateListener();
    const now = Date.now;
    listener('background');
    Date.now = () => now() - 60 * 60 * 1000;
    try {
      listener('active');
    } finally {
      Date.now = now;
    }
    expect(Vault.isUnlocked).toBe(false);
  });

  it('opção "Bloquear ao minimizar/desligar a tela" bloqueia imediatamente', async () => {
    await unlockReal();
    await Vault.updateSettings({ lockOnBackground: true });
    SessionService.start();
    lastAppStateListener()('background');
    expect(Vault.isUnlocked).toBe(false);
    await unlockReal();
    await Vault.updateSettings({ lockOnBackground: false });
  });

  it('pausar/retomar e bloquear manualmente', async () => {
    if (!Vault.isUnlocked) await unlockReal();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    SessionService.start();
    SessionService.pause();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(Vault.isUnlocked).toBe(true);
    SessionService.resume();
    expect(SessionService.lastActivity).toBeGreaterThan(0);
    SessionService.lockNow();
    expect(Vault.isUnlocked).toBe(false);
  });
});

describe('Área de transferência', () => {
  it('BDD: a senha copiada é apagada após 30 segundos', async () => {
    jest.useRealTimers();
    await unlockReal();
    const set = jest.spyOn(System, 'setClipboard');
    const clear = jest.spyOn(System, 'clearClipboardIf');
    const states: any[] = [];
    const toasts: any[] = [];
    const off1 = bus.on(CLIPBOARD_EVENT, s => states.push(s));
    const off2 = bus.on(Events.TOAST, t => toasts.push(t));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    await ClipboardService.copy('Minha#Senha123', 'Senha');
    expect(set).toHaveBeenCalledWith('Minha#Senha123', true);
    expect(toasts[0].message).toBe('Senha copiada, será apagada em breve');
    expect(ClipboardService.state?.label).toBe('Senha');
    jest.advanceTimersByTime(29 * 1000);
    expect(clear).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1500);
    expect(clear).toHaveBeenCalledWith('Minha#Senha123');
    expect(ClipboardService.state).toBeNull();
    expect(states[states.length - 1]).toBeNull();
    off1();
    off2();
  });

  it('bloquear o cofre apaga a senha copiada na hora', async () => {
    jest.useRealTimers();
    if (!Vault.isUnlocked) await unlockReal();
    const clear = jest.spyOn(System, 'clearClipboardIf').mockClear();
    await ClipboardService.copy('Senha#DoBloqueio1', 'Senha');
    await Vault.lock('manual');
    await new Promise(r => setTimeout(r, 10));
    expect(clear).toHaveBeenCalledWith('Senha#DoBloqueio1');
    expect(ClipboardService.state).toBeNull();
  });

  it('respeita o tempo configurado, limpa ao minimizar e não agenda limpeza para dados não sensíveis', async () => {
    jest.useRealTimers();
    if (!Vault.isUnlocked) await unlockReal();
    await Vault.updateSettings({ clipboardSeconds: 15 });
    const clear = jest.spyOn(System, 'clearClipboardIf').mockClear();
    await ClipboardService.copy('usuario@x.com', 'Usuário', false);
    expect(ClipboardService.state).toBeNull();
    await ClipboardService.copy('Outra#Senha', 'Senha');
    expect(ClipboardService.state!.expiresAt - Date.now()).toBeLessThanOrEqual(15000);
    // App minimizado → limpa na hora
    const calls = (AppState.addEventListener as jest.Mock).mock.calls.filter(c => c[0] === 'change');
    calls.forEach(c => c[1]('background'));
    await new Promise(r => setTimeout(r, 10));
    expect(clear).toHaveBeenCalledWith('Outra#Senha');
    expect(ClipboardService.state).toBeNull();
  });
});
