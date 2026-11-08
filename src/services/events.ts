// Barramento de eventos simples do app
type Handler = (payload?: any) => void;

class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, payload?: any) {
    this.handlers.get(event)?.forEach(h => {
      try {
        h(payload);
      } catch (e) {
        console.warn('[EventBus]', event, e);
      }
    });
  }
}

export const bus = new EventBus();

export const Events = {
  LOCKED: 'locked',
  UNLOCKED: 'unlocked',
  DATA_CHANGED: 'dataChanged',
  INTEGRITY_CHECKED: 'integrityChecked',
  SETTINGS_CHANGED: 'settingsChanged',
  TOAST: 'toast',
  /** Interação do usuário que não passa pelo toque na tela (digitação no teclado do sistema). */
  ACTIVITY: 'activity',
  /** Tentativa de desbloqueio (senha, biometria, recuperação, 2FA): { profileId, method, success, detail }. */
  AUTH_ATTEMPT: 'authAttempt',
  /** Novo alerta de segurança (AlertService). */
  ALERT: 'alert',
  /** Lista de perfis alterada (criado, renomeado, excluído ou trocado). */
  PROFILES_CHANGED: 'profilesChanged',
} as const;

export interface AuthAttemptEvent {
  profileId: string;
  method: 'password' | 'biometric' | 'recovery' | 'totp';
  success: boolean;
  detail?: string;
  at: string;
}

export function toast(message: string, kind: 'success' | 'error' | 'info' = 'info') {
  bus.emit(Events.TOAST, { message, kind });
}
