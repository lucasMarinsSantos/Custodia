// Validade das credenciais e idade das senhas
//  •: data de validade definida pelo usuário; vencida, a credencial fica inativa (fora do preenchimento
//    automático) até ser renovada.
//  •: sugestão de troca quando a senha passa do prazo (90 dias por padrão, o prazo próprio da credencial
//    ou a regra da pasta), com destaque das vencidas e das antigas e alertas sem repetição.
// A rotina `sweep()` roda no desbloqueio e uma vez por dia enquanto o cofre estiver aberto.

import { vaultDb } from '../db/Database';
import { AppSettings, Credential, Folder } from '../types/models';
import { formatDate } from '../utils';
import { AlertService } from './AlertService';
import { PolicyService } from './PolicyService';
import { Repo } from './Repository';
import { Vault } from './VaultService';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Prazo padrão para sugerir a troca, quando nem os ajustes nem a pasta definem outro. */
export const DEFAULT_MAX_AGE_DAYS = 90;
/** A partir de quantos dias antes do vencimento a credencial aparece como "vence em breve". */
export const EXPIRING_SOON_DAYS = 7;
/** Maior prazo aceito para a troca (10 anos): evita números absurdos vindos de importação ou sincronização. */
export const MAX_AGE_LIMIT_DAYS = 3650;

/** Chaves (tabela kv do banco cifrado) da memória de alertas já emitidos e da última varredura. */
const ALERTED_KEY = 'expiry:alerted';
const LAST_SWEEP_KEY = 'expiry:lastSweep';

export type ExpiryState = 'none' | 'valid' | 'expiring' | 'expired';
export type MaxAgeSource = 'credential' | 'folder' | 'default';
/** expired: passou da data de validade; old: senha mais antiga que o prazo de troca. */
export type AttentionKind = 'expired' | 'old';

/** Prazos oferecidos na interface (dias). */
export const MAX_AGE_CHOICES = [30, 60, 90, 180, 365];
export const EXPIRY_CHOICES = [30, 90, 180, 365];

export const MaxAgeSourceLabels: Record<MaxAgeSource, string> = {
  credential: 'prazo desta credencial',
  folder: 'regra da pasta',
  default: 'padrão dos ajustes',
};

export interface RotationInfo {
  /** Dias desde a última troca da senha. */
  ageDays: number;
  /** Prazo que vale para esta credencial. */
  maxAgeDays: number;
  source: MaxAgeSource;
  /** true quando a senha passou do prazo: "Recomendamos trocar esta senha". */
  needsChange: boolean;
}

export interface SweepResult {
  inactivated: number;
  expired: number;
  old: number;
  alerts: number;
}

type ExpirySettings = Pick<AppSettings, 'passwordMaxAgeDays' | 'autoInactiveOnExpire'>;

const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Meia-noite local do dia de `ms` (as datas de validade valem a partir do início do dia escolhido). */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function validDays(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_AGE_LIMIT_DAYS) : null;
}

let dailyTimer: ReturnType<typeof setTimeout> | null = null;

async function loadAlerted(): Promise<Record<string, string>> {
  try {
    const raw = await vaultDb.getKv(ALERTED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export const ExpiryService = {
  // ---------------------------------------------------------------------------
  // Validade
  // ---------------------------------------------------------------------------
  isExpired(c: Pick<Credential, 'expiresAt'>, now = Date.now()): boolean {
    const t = time(c.expiresAt);
    return !Number.isNaN(t) && t <= now;
  },

  /** Dias de calendário até o vencimento (0 = vence hoje, negativo = já venceu); null sem validade. */
  daysLeft(c: Pick<Credential, 'expiresAt'>, now = Date.now()): number | null {
    const t = time(c.expiresAt);
    if (Number.isNaN(t)) return null;
    return Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS);
  },

  state(c: Pick<Credential, 'expiresAt'>, now = Date.now()): ExpiryState {
    const left = this.daysLeft(c, now);
    if (left === null) return 'none';
    if (this.isExpired(c, now)) return 'expired';
    return left <= EXPIRING_SOON_DAYS ? 'expiring' : 'valid';
  },

  /** Indicador de tempo restante mostrado no detalhe e na lista. */
  expiryLabel(c: Pick<Credential, 'expiresAt'>, now = Date.now()): string {
    const left = this.daysLeft(c, now);
    if (left === null) return 'Sem data de validade';
    if (this.isExpired(c, now)) {
      const ago = Math.max(0, -left);
      if (ago === 0) return 'Venceu hoje';
      return ago === 1 ? 'Venceu ontem' : `Venceu há ${ago} dias`;
    }
    if (left === 0) return 'Vence hoje';
    return left === 1 ? 'Vence amanhã' : `Vence em ${left} dias`;
  },

  /**
   * Pode ser usada no preenchimento automático: nem inativa, nem vencida. A data é
   * conferida também aqui porque a varredura roda no desbloqueio e uma vez por dia (pode vencer no meio do dia).
   */
  isActive(c: Pick<Credential, 'expiresAt' | 'inactive'>, now = Date.now()): boolean {
    return !c.inactive && !this.isExpired(c, now);
  },

  /** Ao renovar (data nova no futuro ou sem validade), a credencial inativa volta a ficar ativa. */
  applyRenewal(c: Credential, now = Date.now()): Credential {
    if (!c.inactive || this.isExpired(c, now)) return c;
    return { ...c, inactive: false };
  },

  /** Renova a validade para `days` dias a partir de hoje e reativa a credencial. */
  async renew(id: string, days: number): Promise<Credential | null> {
    const cred = await Repo.credential(id);
    if (!cred) return null;
    return Repo.saveCredential({ ...cred, expiresAt: this.addDays(days), inactive: false });
  },

  // ---------------------------------------------------------------------------
  // Idade da senha
  // ---------------------------------------------------------------------------
  passwordAgeDays(c: Pick<Credential, 'passwordChangedAt' | 'createdAt'>, now = Date.now()): number {
    const t = time(c.passwordChangedAt || c.createdAt);
    if (Number.isNaN(t)) return 0;
    return Math.max(0, Math.floor((now - t) / DAY_MS));
  },

  ageLabel(days: number): string {
    if (days <= 0) return 'Senha alterada hoje';
    return `Senha alterada há ${days} ${plural(days, 'dia', 'dias')}`;
  },

  /**
   * Prazo que vale para a credencial: o próprio (`maxPasswordAgeDays`) e o da regra da pasta (`maxAgeDays`,
   * via PolicyService); havendo os dois, vale o menor (o mais rígido). Sem nenhum, vale o padrão dos ajustes.
   */
  maxAgeFor(c: Credential, folders: Folder[], settings: Partial<ExpirySettings> = Vault.settings): { days: number; source: MaxAgeSource } {
    const own = validDays(c.maxPasswordAgeDays);
    const folder = validDays(PolicyService.forCredential(folders, c).maxAgeDays);
    if (own !== null && (folder === null || own <= folder)) return { days: own, source: 'credential' };
    if (folder !== null) return { days: folder, source: 'folder' };
    return { days: validDays(settings.passwordMaxAgeDays) ?? DEFAULT_MAX_AGE_DAYS, source: 'default' };
  },

  rotation(c: Credential, folders: Folder[], now = Date.now(), settings?: Partial<ExpirySettings>): RotationInfo {
    const ageDays = this.passwordAgeDays(c, now);
    const { days, source } = this.maxAgeFor(c, folders, settings);
    return { ageDays, maxAgeDays: days, source, needsChange: !!c.password && ageDays > days };
  },

  /** Vencidas e antigas (uma credencial vencida não é listada também como antiga). */
  attention(creds: Credential[], folders: Folder[], now = Date.now(), settings?: Partial<ExpirySettings>): { expired: Credential[]; old: Credential[] } {
    const expired: Credential[] = [];
    const old: Credential[] = [];
    for (const c of creds) {
      if (this.isExpired(c, now)) expired.push(c);
      else if (this.rotation(c, folders, now, settings).needsChange) old.push(c);
    }
    return { expired, old };
  },

  /** Situação de cada credencial que precisa de atenção (para marcar a lista sem recalcular por linha). */
  statusMap(creds: Credential[], folders: Folder[], now = Date.now(), settings?: Partial<ExpirySettings>): Map<string, AttentionKind> {
    const { expired, old } = this.attention(creds, folders, now, settings);
    const map = new Map<string, AttentionKind>();
    for (const c of expired) map.set(c.id, 'expired');
    for (const c of old) map.set(c.id, 'old');
    return map;
  },

  /** Filtro rápido "Vencidas / Trocar" do cofre. */
  needsAttention(c: Credential, folders: Folder[], now = Date.now(), settings?: Partial<ExpirySettings>): boolean {
    return this.isExpired(c, now) || this.rotation(c, folders, now, settings).needsChange;
  },

  // ---------------------------------------------------------------------------
  // Varredura: inativa as vencidas e gera os alertas (sem repetir)
  // ---------------------------------------------------------------------------
  async sweep(now = Date.now()): Promise<SweepResult> {
    const result: SweepResult = { inactivated: 0, expired: 0, old: 0, alerts: 0 };
    if (!vaultDb.isOpen) return result;
    const [creds, folders] = await Promise.all([Repo.credentials(), Repo.folders()]);
    const settings = Vault.settings;
    const { expired, old } = this.attention(creds, folders, now, settings);
    result.expired = expired.length;
    result.old = old.length;

    // Um alerta por credencial e por situação: só volta a aparecer se a data de validade ou a senha mudar
    const before = await loadAlerted();
    const after: Record<string, string> = {};
    const raiseOnce = async (key: string, signature: string, raise: () => Promise<unknown>) => {
      after[key] = signature;
      if (before[key] === signature) return;
      await raise();
      result.alerts++;
    };

    for (const c of expired) {
      if (settings.autoInactiveOnExpire !== false && !c.inactive) {
        await Repo.setInactive(c.id, true);
        result.inactivated++;
      }
      await raiseOnce(`expired:${c.id}`, String(c.expiresAt), () =>
        AlertService.raise({
          type: 'expired',
          severity: 'danger',
          title: 'Credencial vencida',
          message: `"${c.title}" venceu em ${formatDate(c.expiresAt)}. Atualize a senha e renove a validade.`,
          ref: c.id,
        }),
      );
    }
    for (const c of old) {
      const info = this.rotation(c, folders, now, settings);
      await raiseOnce(`old:${c.id}`, String(c.passwordChangedAt), () =>
        AlertService.raise({
          type: 'old',
          severity: 'warning',
          title: 'Recomendamos trocar esta senha',
          message: `A senha de "${c.title}" foi alterada há ${info.ageDays} dias (prazo de ${info.maxAgeDays} dias).`,
          ref: c.id,
        }),
      );
    }
    await vaultDb.setKv(ALERTED_KEY, JSON.stringify(after));
    await vaultDb.setKv(LAST_SWEEP_KEY, new Date(now).toISOString());
    return result;
  },

  async lastSweep(): Promise<string | null> {
    return vaultDb.isOpen ? vaultDb.getKv(LAST_SWEEP_KEY) : null;
  },

  /** Agenda a varredura diária (chamado no desbloqueio; `stopDaily` no bloqueio). */
  startDaily(intervalMs = DAY_MS) {
    this.stopDaily();
    const tick = () => {
      dailyTimer = setTimeout(() => {
        this.sweep()
          .catch(e => console.warn('[Validade] varredura diária', e))
          .finally(() => {
            if (dailyTimer) tick();
          });
      }, intervalMs);
      (dailyTimer as any)?.unref?.();
    };
    tick();
  },

  stopDaily() {
    if (dailyTimer) clearTimeout(dailyTimer);
    dailyTimer = null;
  },

  // ---------------------------------------------------------------------------
  // Datas digitadas na interface (DD/MM/AAAA)
  // ---------------------------------------------------------------------------
  /** Converte DD/MM/AAAA para ISO (meia-noite local); null se a data não existir. */
  parseDate(text: string): string | null {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
    if (!m) return null;
    const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (year < 2000 || year > 2200) return null;
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return d.toISOString();
  },

  /** ISO → DD/MM/AAAA para o campo de edição. */
  toInput(iso: string | null | undefined): string {
    return iso ? formatDate(iso) : '';
  },

  /** Meia-noite local de daqui a `days` dias, em ISO. */
  addDays(days: number, now = Date.now()): string {
    const d = new Date(startOfDay(now));
    d.setDate(d.getDate() + days);
    return d.toISOString();
  },
};
