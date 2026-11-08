// Ponte para o módulo nativo CustodiaNotifications (NotificationModule.kt), notificações de segurança
// Canal "Alertas de segurança", visibilidade privada na tela de bloqueio e permissão POST_NOTIFICATIONS no
// Android 13+. O conteúdo nunca traz segredos (ver NotificationService). Sem o módulo nativo, guarda em memória.

import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

const M: any = NativeModules || {};

export interface SentNotification {
  id: number;
  title: string;
  body: string;
}

const sent: SentNotification[] = [];

/** Apenas para testes: notificações "enviadas" sem o módulo nativo. */
export function __sentNotifications(): SentNotification[] {
  return sent;
}

export const Notifications = {
  async notify(id: number, title: string, body: string): Promise<void> {
    if (M.CustodiaNotifications) return M.CustodiaNotifications.notify(id, title, body);
    sent.push({ id, title, body });
    if (sent.length > 50) sent.shift();
  },

  /** As notificações do app estão liberadas (permissão e chave geral do sistema)? */
  async enabled(): Promise<boolean> {
    if (M.CustodiaNotifications) return M.CustodiaNotifications.enabled();
    return true;
  },

  /** Pede a permissão POST_NOTIFICATIONS (só existe a partir do Android 13, API 33). */
  async requestPermission(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    if (Number(Platform.Version) < 33) return this.enabled();
    const perm = (PermissionsAndroid.PERMISSIONS as any).POST_NOTIFICATIONS || 'android.permission.POST_NOTIFICATIONS';
    const r = await PermissionsAndroid.request(perm);
    return r === PermissionsAndroid.RESULTS.GRANTED;
  },
};
