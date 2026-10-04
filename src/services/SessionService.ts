// Monitoramento de sessão e bloqueio automático
//  • Encerra a sessão após N minutos de inatividade (padrão 5 min); qualquer toque reinicia o contador
//  • Bloqueia ao minimizar/desligar a tela (opcional) ou exige reautenticação após período configurável
//  • Bloqueia imediatamente ao virar o aparelho para baixo ou colocá-lo no bolso
//    (sensor de proximidade + acelerômetro)

import { AppState, AppStateStatus } from 'react-native';
import { ExternalActivity, onNativeEvent, System } from '../native';
import { Vault } from './VaultService';
import { bus, Events, toast } from './events';

let inactivityTimer: any = null;
let warningTimer: any = null;
/** Aviso antes do bloqueio por inatividade, para o usuário não perder o que está digitando. */
export const LOCK_WARNING_SECONDS = 15;
let paused = false;
/** Só o bloqueio por inatividade fica suspenso (ex.: enquanto o usuário anota o código de recuperação). */
let inactivityHeld = false;
let backgroundAt: number | null = null;
let externalActivity = 0; // seletor de arquivo/imagem (não bloquear)
let sensorSub: (() => void) | null = null;
let appStateSub: { remove: () => void } | null = null;
let lastActivity = Date.now();

function clearTimers() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (warningTimer) clearTimeout(warningTimer);
  inactivityTimer = null;
  warningTimer = null;
}

function resetTimer() {
  clearTimers();
  if (!Vault.isUnlocked || paused || inactivityHeld) return;
  const minutes = Vault.settings.autoLockMinutes || 5;
  const ms = minutes * 60 * 1000;
  if (ms > LOCK_WARNING_SECONDS * 2000) {
    warningTimer = setTimeout(() => {
      if (!paused && Vault.isUnlocked) toast(`O cofre será bloqueado em ${LOCK_WARNING_SECONDS} s por inatividade. Toque na tela para continuar.`, 'info');
    }, ms - LOCK_WARNING_SECONDS * 1000);
  }
  inactivityTimer = setTimeout(() => {
    if (!paused) Vault.lock('inatividade');
  }, ms);
}

const inExternal = () => externalActivity > 0 || ExternalActivity.count > 0 || Date.now() - ExternalActivity.lastEnded < 4000;

function onAppState(state: AppStateStatus) {
  if (!Vault.isUnlocked) return;
  if (state === 'background') {
    backgroundAt = Date.now();
    if (inExternal() || paused) {
      backgroundAt = null;
      return;
    }
    if (Vault.settings.lockOnBackground) Vault.lock('app minimizado');
  } else if (state === 'active') {
    if (backgroundAt) {
      const awayMin = (Date.now() - backgroundAt) / 60000;
      // Tempo negativo = relógio atrasado enquanto o app estava fora: por segurança, pede a senha de novo
      if (awayMin < 0 || awayMin >= (Vault.settings.reauthAfterMinutes ?? 5)) Vault.lock('reautenticação necessária');
    }
    backgroundAt = null;
    resetTimer();
  }
}

export const SessionService = {
  start() {
    lastActivity = Date.now();
    resetTimer();
    appStateSub?.remove();
    appStateSub = AppState.addEventListener('change', onAppState);
    // Sensores (proximidade/acelerômetro)
    sensorSub?.();
    if (Vault.settings.proximityLock) {
      System.startSensors().catch(() => {});
      sensorSub = onNativeEvent('CustodiaSystem', 'CustodiaSensor', (e: any) => {
        if (Vault.isUnlocked && !inExternal()) Vault.lock(e?.kind === 'faceDown' ? 'aparelho virado para baixo' : 'aparelho no bolso');
      });
    } else {
      // Opção desligada nos Ajustes: os sensores param na hora (não só no próximo bloqueio)
      System.stopSensors().catch(() => {});
    }
  },

  stop() {
    clearTimers();
    sensorSub?.();
    sensorSub = null;
    System.stopSensors().catch(() => {});
    appStateSub?.remove();
    appStateSub = null;
    paused = false;
  },

  /** Chamado a cada toque do usuário (throttled). */
  activity() {
    const now = Date.now();
    if (now - lastActivity < 1000) return;
    lastActivity = now;
    resetTimer();
  },

  /** Suspende apenas o bloqueio por inatividade; segundo plano e sensores continuam bloqueando. */
  holdInactivity(hold: boolean) {
    inactivityHeld = hold;
    resetTimer();
  },

  pause() {
    paused = true;
    clearTimers();
  },

  resume() {
    paused = false;
    resetTimer();
  },

  /** Envolve ações que abrem outra Activity (seletor de arquivos) sem bloquear o cofre. */
  async external<T>(fn: () => Promise<T>): Promise<T> {
    externalActivity++;
    try {
      return await fn();
    } finally {
      setTimeout(() => {
        externalActivity = Math.max(0, externalActivity - 1);
      }, 1500);
    }
  },

  lockNow() {
    Vault.lock('manual');
  },

  /** Momento (ms) da última interação registrada. */
  get lastActivity() {
    return lastActivity;
  },
};

bus.on(Events.LOCKED, () => SessionService.stop());
bus.on(Events.ACTIVITY, () => SessionService.activity());
bus.on(Events.SETTINGS_CHANGED, () => {
  if (Vault.isUnlocked) SessionService.start();
});
