// Histórico de acessos e alerta de login falho
//
// Cada tentativa de desbloqueio (senha, biometria, recuperação e 2FA) chega pelo evento AUTH_ATTEMPT.
//  • Cofre fechado: a tentativa vai para uma fila nas preferências cifradas pelo Keystore
//    (`p:<perfil>:pendingAccess`), com limite de tamanho; quem tenta adivinhar a senha não consegue apagá-la.
//  • No desbloqueio: a fila vai para a coleção `accessLog` do banco cifrado, o que passou da retenção
//    (ACCESS_LOG_RETENTION_DAYS, nunca menos de 30 dias) é apagado e, se houve falhas, o dono vê "N tentativas de
//    acesso falharam desde o último acesso" e um alerta "Tentativa de acesso falha em <data e hora>".
//  • Cofre aberto (reautenticação, troca de senha): a falha vai direto para o banco e gera o mesmo alerta.
// O "local" de cada tentativa é o modelo do aparelho e o tipo de rede (sem GPS e sem IP).

import { Platform } from 'react-native';
import { vaultDb } from '../db/Database';
import { uuid } from '../crypto';
import { Security } from '../native';
import { Net } from '../native/net';
import { ACCESS_LOG_RETENTION_DAYS, AccessLogEntry, AccessMethod } from '../types/models';
import { AlertService } from './AlertService';
import { AuthAttemptEvent, bus, Events } from './events';
import { formatDate } from '../utils';
import { afterIntegrityCheck } from './unlockGate';

/** Requisito: histórico de no mínimo 30 dias. */
export const MIN_RETENTION_DAYS = 30;
export const RETENTION_DAYS = Math.max(MIN_RETENTION_DAYS, ACCESS_LOG_RETENTION_DAYS);
/** Tamanho máximo da fila com o cofre fechado (um atacante insistente não enche o armazenamento). */
export const MAX_PENDING = 200;
/** Tamanho máximo do histórico no banco. */
export const MAX_LOG_ENTRIES = 5000;
const MAX_DETAIL = 120;
const DAY = 86400000;
const METHODS: AccessMethod[] = ['password', 'biometric', 'recovery', 'totp'];

export const MethodLabels: Record<AccessMethod, string> = {
  password: 'Senha mestra',
  biometric: 'Biometria',
  recovery: 'Recuperação',
  totp: 'Código 2FA',
};

interface PendingQueue {
  entries: AccessLogEntry[];
  /** Tentativas descartadas por estourar o limite (continuam contando no aviso). */
  droppedFailures: number;
}

export interface FlushResult {
  moved: number;
  failures: number;
  lastFailureAt: string | null;
  message: string | null;
}

const pendingKey = (profileId: string) => `p:${profileId}:pendingAccess`;
const validProfile = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

let chain: Promise<unknown> = Promise.resolve();
let off: (() => void) | null = null;

/** Executa em fila: tentativas seguidas e o desbloqueio não se sobrescrevem na mesma chave. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function networkLabel(type: string): string {
  const labels: Record<string, string> = { wifi: 'Wi-Fi', cellular: 'dados móveis', ethernet: 'cabo', vpn: 'VPN', none: 'sem rede' };
  return labels[type] || '';
}

/** "Samsung SM-G991B • Wi-Fi": modelo do aparelho e rede, sem localização. */
export async function deviceLabel(): Promise<string> {
  const c: any = (Platform as any).constants || {};
  const model = [c.Brand || c.Manufacturer, c.Model].filter(Boolean).join(' ').trim() || 'Este aparelho';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(r => {
    timer = setTimeout(() => r(null), 1500);
  });
  const net = await Promise.race([Net.networkInfo().catch(() => null), timeout]);
  clearTimeout(timer);
  const label = net ? networkLabel(net.type) : '';
  return (label ? `${model} • ${label}` : model).slice(0, 80);
}

/** Converte o evento numa entrada válida (o evento pode vir de outros módulos: nada é confiado às cegas). */
export function toEntry(ev: AuthAttemptEvent, device: string): AccessLogEntry | null {
  if (!ev || !METHODS.includes(ev.method)) return null;
  const at = Number.isNaN(Date.parse(ev.at)) ? new Date().toISOString() : new Date(ev.at).toISOString();
  const detail = typeof ev.detail === 'string' && ev.detail ? ev.detail.slice(0, MAX_DETAIL) : undefined;
  return { id: uuid(), at, method: ev.method, success: !!ev.success, detail, device };
}

async function readQueue(profileId: string): Promise<PendingQueue> {
  try {
    const raw = await Security.secureGet(pendingKey(profileId));
    const q = raw ? JSON.parse(raw) : null;
    if (q && Array.isArray(q.entries)) return { entries: q.entries.slice(-MAX_PENDING), droppedFailures: Number(q.droppedFailures) || 0 };
  } catch {
    // fila corrompida: recomeça vazia
  }
  return { entries: [], droppedFailures: 0 };
}

async function writeQueue(profileId: string, q: PendingQueue): Promise<void> {
  await Security.secureSet(pendingKey(profileId), JSON.stringify(q));
}

async function purgeOld(now: number): Promise<void> {
  const all = await vaultDb.all<AccessLogEntry>('accessLog');
  const limit = now - RETENTION_DAYS * DAY;
  const sorted = all.sort((a, b) => b.at.localeCompare(a.at));
  for (const [i, e] of sorted.entries()) {
    if (i >= MAX_LOG_ENTRIES || Date.parse(e.at) < limit) await vaultDb.remove('accessLog', e.id, { silent: true });
  }
}

/** Título do alerta: "Tentativa de acesso falha em 03/11/2026 14:05" (a data também evita a deduplicação). */
export function failureTitle(at: string): string {
  return `${FAILED_ATTEMPT_TITLE} em ${formatDate(at, true)}`;
}

export const FAILED_ATTEMPT_TITLE = 'Tentativa de acesso falha';

export function failureMessage(n: number): string {
  return n === 1 ? '1 tentativa de acesso falhou desde o último acesso' : `${n} tentativas de acesso falharam desde o último acesso`;
}

export const AccessLogService = {
  /** Começa a escutar as tentativas de desbloqueio e o desbloqueio do cofre. */
  init() {
    if (off) return;
    const a = bus.on(Events.AUTH_ATTEMPT, (ev: AuthAttemptEvent) => {
      this.record(ev).catch(e => console.warn('[Acessos] falha ao registrar tentativa', e?.message));
    });
    const b = bus.on(Events.UNLOCKED, () => {
      const id = vaultDb.profileId;
      if (id) this.flush(id).catch(e => console.warn('[Acessos] falha ao mover a fila', e?.message));
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

  /** Registra uma tentativa: direto no banco se o cofre do mesmo perfil está aberto, senão na fila cifrada. */
  async record(ev: AuthAttemptEvent): Promise<void> {
    if (!validProfile(ev?.profileId) || !toEntry(ev, '')) return;
    // Entra na fila na hora (antes de ler a rede): o desbloqueio que vem logo depois espera esta gravação
    await enqueue(async () => {
      const entry = toEntry(ev, await deviceLabel())!;
      if (vaultDb.isOpen && vaultDb.profileId === ev.profileId) {
        await vaultDb.put('accessLog', entry, { silent: true });
        if (!entry.success) {
          await AlertService.raise({
            type: 'login_failed',
            severity: 'warning',
            title: failureTitle(entry.at),
            message: `${MethodLabels[entry.method]}: ${entry.detail || 'falha na autenticação'}. Se não foi você, troque a senha mestra.`,
            createdAt: entry.at,
          });
        }
        bus.emit(Events.DATA_CHANGED);
        return;
      }
      const q = await readQueue(ev.profileId);
      q.entries.push(entry);
      while (q.entries.length > MAX_PENDING) {
        const dropped = q.entries.shift();
        if (dropped && !dropped.success) q.droppedFailures++;
      }
      await writeQueue(ev.profileId, q);
    });
  },

  /** Resolve quando as gravações em andamento terminarem. */
  idle(): Promise<void> {
    return chain.then(() => undefined);
  },

  /** Falhas consecutivas na fila (para a notificação imediata com o cofre fechado). */
  async pendingFailures(profileId: string): Promise<number> {
    if (!validProfile(profileId)) return 0;
    const q = await readQueue(profileId);
    let n = 0;
    for (let i = q.entries.length - 1; i >= 0 && !q.entries[i].success; i--) n++;
    return n;
  },

  /**
   * No desbloqueio: move a fila para o banco cifrado, apaga o que passou da retenção e avisa das falhas.
   * Espera as tentativas ainda sendo gravadas (a do próprio desbloqueio).
   */
  async flush(profileId: string, now = Date.now()): Promise<FlushResult> {
    return enqueue(async () => {
      // Só grava depois da verificação de integridade do desbloqueio (senão ela acusaria o próprio histórico)
      await afterIntegrityCheck();
      if (!vaultDb.isOpen || vaultDb.profileId !== profileId) return { moved: 0, failures: 0, lastFailureAt: null, message: null };
      const q = await readQueue(profileId);
      for (const e of q.entries) {
        if (e && typeof e.id === 'string' && METHODS.includes(e.method)) await vaultDb.put('accessLog', e, { silent: true });
      }
      await Security.secureRemove(pendingKey(profileId));
      await purgeOld(now);
      const failed = q.entries.filter(e => !e.success);
      const failures = failed.length + q.droppedFailures;
      const lastFailureAt = failed.length ? failed.map(e => e.at).sort().pop()! : null;
      let message: string | null = null;
      if (failures > 0) {
        message = failureMessage(failures);
        const when = lastFailureAt ? ` A última foi em ${formatDate(lastFailureAt, true)}.` : '';
        await AlertService.raise({
          type: 'login_failed',
          severity: failures >= 3 ? 'danger' : 'warning',
          title: failureTitle(lastFailureAt || new Date(now).toISOString()),
          message: `${message}.${when} Se não foi você, troque a senha mestra.`,
          createdAt: new Date(now).toISOString(),
        });
        bus.emit(Events.TOAST, { message, kind: 'error' });
      }
      if (q.entries.length) bus.emit(Events.DATA_CHANGED);
      return { moved: q.entries.length, failures, lastFailureAt, message };
    });
  },

  /** Histórico do mais recente para o mais antigo (dentro da retenção). */
  async list(opts: { onlyFailures?: boolean } = {}, now = Date.now()): Promise<AccessLogEntry[]> {
    const limit = now - RETENTION_DAYS * DAY;
    return (await vaultDb.all<AccessLogEntry>('accessLog'))
      .filter(e => Date.parse(e.at) >= limit && (!opts.onlyFailures || !e.success))
      .sort((a, b) => b.at.localeCompare(a.at));
  },
};
