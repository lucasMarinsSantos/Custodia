// Monitor de segurança: liga os serviços de segurança ao ciclo de vida do cofre
//  • Histórico de acessos e notificações do sistema
//  • Vazamentos: verificação automática ao salvar/alterar uma senha e periódica (a cada 7 dias),
//    quando "breachAutoCheck" está ligado. Sem rede, a verificação é adiada sem incomodar o usuário.
//    A periódica roda no desbloqueio e quando o app volta ao primeiro plano (timers de JS não rodam em segundo
//    plano no Android, e um intervalo longo só manteria um timer pendurado).
// Chamado uma vez por AppController.init().

import { AppState } from 'react-native';
import { vaultDb } from '../db/Database';
import { AccessLogService } from './AccessLogService';
import { BreachOfflineError, BreachService } from './BreachService';
import { bus, Events } from './events';
import { NotificationService } from './NotificationService';
import { Repo } from './Repository';
import { Vault } from './VaultService';
import { afterIntegrityCheck } from './unlockGate';

/** Espera depois de salvar antes de consultar (edições seguidas viram uma consulta só). */
export const AUTO_CHECK_DEBOUNCE_MS = 1500;
/** Espera depois do desbloqueio antes da verificação periódica (não atrasa a abertura do cofre). */
export const PERIODIC_DELAY_MS = 5000;
const KV_NOTIF_ASKED = 'notifPermissionAsked';

let initialized = false;
const pendingIds = new Set<string>();
let debounce: ReturnType<typeof setTimeout> | null = null;
let periodicTimer: ReturnType<typeof setTimeout> | null = null;
let periodicRunning = false;

const autoEnabled = () => Vault.isUnlocked && !!Vault.settings.breachAutoCheck;

function logDeferred(e: any) {
  if (e instanceof BreachOfflineError) console.warn('[Vazamentos] verificação automática adiada: sem rede');
  else console.warn('[Vazamentos] verificação automática falhou:', e?.message);
}

function clearTimers() {
  if (debounce) clearTimeout(debounce);
  if (periodicTimer) clearTimeout(periodicTimer);
  debounce = periodicTimer = null;
  pendingIds.clear();
}

export const SecurityMonitor = {
  init() {
    if (initialized) return;
    initialized = true;
    // A ordem importa: o histórico grava a tentativa antes de a notificação contar as falhas
    AccessLogService.init();
    NotificationService.init();

    vaultDb.onWrite(e => {
      if (e.collection !== 'credentials') return;
      if (e.deleted) {
        BreachService.forget(e.id).catch(() => {});
        return;
      }
      if (!autoEnabled()) return;
      pendingIds.add(e.id);
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        this.runAutoChecks().catch(logDeferred);
      }, AUTO_CHECK_DEBOUNCE_MS);
    });

    bus.on(Events.UNLOCKED, () => {
      this.onUnlocked().catch(e => console.warn('[Segurança] desbloqueio', e?.message));
    });
    AppState.addEventListener?.('change', st => {
      if (st === 'active' && Vault.isUnlocked) this.runPeriodic().catch(logDeferred);
    });
    bus.on(Events.LOCKED, () => {
      clearTimers();
      BreachService.clearMemory();
    });
  },

  async onUnlocked() {
    await BreachService.load();
    // As verificações gravam alertas no banco: só depois da verificação de integridade do desbloqueio
    await afterIntegrityCheck();
    if (!Vault.isUnlocked) return;
    if (Vault.settings.securityNotifications && !(await vaultDb.getKv(KV_NOTIF_ASKED))) {
      await vaultDb.setKv(KV_NOTIF_ASKED, new Date().toISOString());
      await NotificationService.ensurePermission();
    }
    if (periodicTimer) clearTimeout(periodicTimer);
    periodicTimer = setTimeout(() => {
      periodicTimer = null;
      this.runPeriodic().catch(logDeferred);
    }, PERIODIC_DELAY_MS);
  },

  /** Verifica as credenciais salvas/alteradas desde a última rodada (só consulta se a senha mudou). */
  async runAutoChecks(): Promise<number> {
    const ids = [...pendingIds];
    pendingIds.clear();
    if (!autoEnabled()) return 0;
    let checked = 0;
    for (const id of ids) {
      const cred = await Repo.credential(id);
      if (!cred || !Vault.isUnlocked) continue;
      const r = await BreachService.checkCredential(cred);
      if (!r.cached) checked++;
    }
    return checked;
  },

  /** Verificação periódica do cofre inteiro, se ligada e vencida. */
  async runPeriodic(): Promise<boolean> {
    if (periodicRunning || !autoEnabled() || !(await BreachService.isDue())) return false;
    periodicRunning = true;
    try {
      const run = await BreachService.checkAll(await Repo.credentials());
      if (run.offline) throw new BreachOfflineError();
      return true;
    } finally {
      periodicRunning = false;
    }
  },

  /** Apenas para testes. */
  _reset() {
    clearTimers();
  },
};
