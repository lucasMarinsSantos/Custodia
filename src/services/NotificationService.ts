// Notificações do sistema para alertas de segurança
// Disparadas no evento ALERT quando "Notificações de segurança" está ligado nos ajustes e, a cada tentativa de
// desbloqueio que falha (cofre aberto ou fechado), "Tentativa de acesso falha" com a data e a hora.
//
// Conteúdo: só textos genéricos por tipo de alerta. Nada de senha, usuário, nome do serviço ou endereço: a
// notificação aparece na barra do sistema e pode ser lida por quem pega o aparelho (na tela de bloqueio o
// canal é privado e mostra apenas "Custódia: alerta de segurança").

import { Notifications } from '../native/notifications';
import { AlertType, SecurityAlert } from '../types/models';
import { AuthAttemptEvent, bus, Events } from './events';
import { Vault } from './VaultService';
import { AccessLogService, FAILED_ATTEMPT_TITLE, MethodLabels } from './AccessLogService';
import { formatDate } from '../utils';

/** Texto seguro por tipo: nunca inclui dados do cofre. */
const SAFE_TEXT: Record<AlertType, [string, string]> = {
  login_failed: [FAILED_ATTEMPT_TITLE, 'Alguém errou o desbloqueio do Custódia. Abra o app para ver o histórico de acessos.'],
  breach: ['Senha encontrada em vazamento', 'Uma senha do seu cofre apareceu em vazamentos de dados. Abra o Custódia para trocá-la.'],
  weak: ['Senha fraca no cofre', 'Há uma senha fraca no seu cofre. Abra o Custódia para ver.'],
  reused: ['Senha repetida no cofre', 'Há senhas repetidas no seu cofre. Abra o Custódia para ver.'],
  old: ['Senha antiga', 'Há uma senha que precisa ser trocada. Abra o Custódia para ver.'],
  expired: ['Credencial vencida', 'Uma credencial do cofre venceu. Abra o Custódia para ver.'],
  phishing: ['Site suspeito', 'Um site parecido com um conhecido foi bloqueado. Abra o Custódia para ver.'],
  ssl: ['Certificado inválido', 'Um site usado no cofre tem um certificado inválido. Abra o Custódia para ver.'],
  integrity: ['Integridade do cofre', 'A verificação de integridade do cofre encontrou um problema. Abra o Custódia.'],
  backup: ['Backup do cofre', 'Há um aviso sobre o backup do cofre. Abra o Custódia para ver.'],
  sync: ['Sincronização', 'Há um aviso sobre a sincronização do cofre. Abra o Custódia para ver.'],
  policy: ['Regra de segurança', 'Uma regra de segurança de pasta não foi cumprida. Abra o Custódia para ver.'],
  new_device: ['Novo aparelho', 'Um novo aparelho foi conectado ao seu cofre. Abra o Custódia para ver.'],
};

export function safeNotification(type: AlertType): { title: string; body: string } {
  const [title, body] = SAFE_TEXT[type] || ['Alerta de segurança', 'Abra o Custódia para ver o alerta.'];
  return { title, body };
}

/** Id estável por tipo (um alerta novo do mesmo tipo substitui o anterior na barra, sem empilhar). */
export function notificationId(type: string): number {
  let h = 7;
  for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) % 100000;
  return 1000 + h;
}

let off: (() => void) | null = null;

async function enabledFor(profileId?: string): Promise<boolean> {
  if (Vault.isUnlocked) return !!Vault.settings.securityNotifications;
  if (!profileId) return false;
  const s = await Vault.loadSettings(profileId).catch(() => null);
  return !!s?.securityNotifications;
}

export const NotificationService = {
  init() {
    if (off) return;
    const a = bus.on(Events.ALERT, (alert: SecurityAlert) => {
      // O aviso de falhas no desbloqueio já foi notificado com o cofre fechado e aparece na tela ao abrir
      if (!alert || alert.type === 'login_failed') return;
      this.notifyAlert(alert).catch(e => console.warn('[Notificações]', e?.message));
    });
    const b = bus.on(Events.AUTH_ATTEMPT, (ev: AuthAttemptEvent) => {
      if (ev && !ev.success) this.onFailedAttempt(ev).catch(e => console.warn('[Notificações]', e?.message));
    });
    off = () => {
      a();
      b();
    };
  },

  /** Apenas para testes. */
  _stop() {
    off?.();
    off = null;
  },

  async notifyAlert(alert: Pick<SecurityAlert, 'type'>): Promise<boolean> {
    if (!(await enabledFor(Vault.currentProfile?.id))) return false;
    const n = safeNotification(alert.type);
    await Notifications.notify(notificationId(alert.type), n.title, n.body);
    return true;
  },

  /**
   * Cada tentativa que falha vira uma notificação "Tentativa de acesso falha" com a data, a hora e o método.
   * Com o cofre fechado, conta também as falhas seguidas (a fila do histórico). Usa sempre o mesmo id: a nova
   * substitui a anterior na barra, sem empilhar.
   */
  async onFailedAttempt(ev: AuthAttemptEvent): Promise<boolean> {
    if (!ev || ev.success || !(await enabledFor(ev.profileId))) return false;
    // Espera a tentativa entrar no histórico antes de contar (AccessLogService escuta antes)
    await AccessLogService.idle();
    const n = Vault.isUnlocked ? 1 : await AccessLogService.pendingFailures(ev.profileId);
    const method = MethodLabels[ev.method] || 'Desbloqueio';
    const streak = n > 1 ? ` ${n} falhas seguidas.` : '';
    const body = `Em ${formatDate(ev.at, true)} (${method}).${streak} Se não foi você, abra o Custódia e veja o histórico de acessos.`;
    await Notifications.notify(notificationId('login_failed'), FAILED_ATTEMPT_TITLE, body);
    return true;
  },

  /** Pede a permissão do Android 13+ (chamado ao ligar a opção ou abrir a tela de alertas). */
  async ensurePermission(): Promise<boolean> {
    try {
      return await Notifications.requestPermission();
    } catch {
      return false;
    }
  },
};
