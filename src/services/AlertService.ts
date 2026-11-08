// Alertas de segurança
// Qualquer serviço registra um alerta aqui. Com o cofre aberto ele vai para o banco cifrado; com o cofre fechado
// fica numa fila em memória e é gravado no próximo desbloqueio. A tela de alertas e as notificações do sistema
// escutam o evento ALERT.

import { vaultDb } from '../db/Database';
import { uuid } from '../crypto';
import { SecurityAlert } from '../types/models';
import { bus, Events } from './events';

/** Um alerta igual (mesmo tipo e item) não lido não é repetido dentro deste intervalo. */
export const ALERT_DEDUP_MS = 24 * 60 * 60 * 1000;
export const MAX_ALERTS = 500;

type NewAlert = Omit<SecurityAlert, 'id' | 'createdAt' | 'read'> & { createdAt?: string };

let pending: SecurityAlert[] = [];

async function store(alert: SecurityAlert): Promise<boolean> {
  const all = await vaultDb.all<SecurityAlert>('alerts');
  const dup = all.find(
    a => !a.read && a.type === alert.type && (a.ref ?? null) === (alert.ref ?? null) && a.title === alert.title && Date.parse(alert.createdAt) - Date.parse(a.createdAt) < ALERT_DEDUP_MS,
  );
  if (dup) return false;
  await vaultDb.put('alerts', alert, { silent: true });
  // Mantém só os mais recentes
  const sorted = all.concat(alert).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const old of sorted.slice(MAX_ALERTS)) await vaultDb.remove('alerts', old.id, { silent: true });
  return true;
}

export const AlertService = {
  async raise(input: NewAlert): Promise<SecurityAlert | null> {
    const alert: SecurityAlert = { ...input, ref: input.ref ?? null, id: uuid(), createdAt: input.createdAt || new Date().toISOString(), read: false };
    if (!vaultDb.isOpen) {
      pending.push(alert);
      bus.emit(Events.ALERT, alert);
      return alert;
    }
    if (!(await store(alert))) return null;
    bus.emit(Events.ALERT, alert);
    bus.emit(Events.DATA_CHANGED);
    return alert;
  },

  /** Grava os alertas que chegaram com o cofre fechado (chamado no desbloqueio). */
  async flushPending(): Promise<void> {
    if (!vaultDb.isOpen || !pending.length) return;
    const list = pending;
    pending = [];
    for (const a of list) await store(a).catch(() => {});
    bus.emit(Events.DATA_CHANGED);
  },

  async list(): Promise<SecurityAlert[]> {
    return (await vaultDb.all<SecurityAlert>('alerts')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async unreadCount(): Promise<number> {
    return (await vaultDb.all<SecurityAlert>('alerts')).filter(a => !a.read).length;
  },

  async markRead(id?: string): Promise<void> {
    const all = await vaultDb.all<SecurityAlert>('alerts');
    for (const a of all) if (!a.read && (!id || a.id === id)) await vaultDb.put('alerts', { ...a, read: true }, { silent: true });
    bus.emit(Events.DATA_CHANGED);
  },

  async remove(id: string): Promise<void> {
    await vaultDb.remove('alerts', id, { silent: true });
    bus.emit(Events.DATA_CHANGED);
  },

  /** Apenas para testes. */
  _resetPending() {
    pending = [];
  },
};
