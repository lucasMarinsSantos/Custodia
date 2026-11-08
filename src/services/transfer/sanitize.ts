// Validação dos dados que entram por arquivo (importação e restauração de backup)
// Tudo o que vem de fora é tratado como hostil: só os campos conhecidos passam, com tipo e tamanho conferidos.
// Os limites de credencial são os mesmos do cadastro (LIMITS do Repository).

import { LIMITS } from '../Repository';
import { CategoryService } from '../CategoryService';
import {
  CategoryLabels,
  Credential,
  CredentialCategory,
  CustomField,
  FormItem,
  NoteAttachment,
  NoteCategory,
  NoteCategoryLabels,
  PasswordHistoryEntry,
  SecureNote,
  ServiceIcon,
} from '../../types/models';

export const NOTE_LIMITS = { content: 50000, attachments: 10, attachmentName: 120, attachmentsBytes: 10 * 1024 * 1024 };
export const FORM_FIELD_MAX = 256;
const MAX_DOMAINS = 50;
const MAX_ICON_IMAGE = 400000;
const FIELD_TYPES: CustomField['type'][] = ['text', 'hidden', 'url', 'email'];

export class SanitizeError extends Error {}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

function limited(value: unknown, max: number, label: string): string {
  const s = str(value);
  if (s.length > max) throw new SanitizeError(`o campo ${label} passa de ${max} caracteres`);
  return s;
}

/** Data ISO válida e não futura (datas futuras viram "agora"), ou null. */
function isoDate(v: unknown): string | null {
  const t = typeof v === 'string' || typeof v === 'number' ? Date.parse(String(v)) : NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(Math.min(t, Date.now())).toISOString();
}

/** Data ISO válida (pode ser futura: validade), ou null. */
function anyDate(v: unknown): string | null {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function stringList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(x => typeof x === 'string' && x.length > 0 && x.length <= maxLen)
    .slice(0, maxItems)
    .map(x => x.trim().toLowerCase());
}

function customFields(v: unknown): CustomField[] {
  if (!Array.isArray(v)) return [];
  if (v.length > LIMITS.customFields) throw new SanitizeError(`use no máximo ${LIMITS.customFields} campos personalizados`);
  return v.map((f: any, i: number) => ({
    id: typeof f?.id === 'string' && f.id.length <= 64 ? f.id : `f${i}-${Date.now()}`,
    label: limited(f?.label, LIMITS.fieldLabel, 'nome do campo personalizado'),
    value: limited(f?.value, LIMITS.fieldValue, 'valor do campo personalizado'),
    type: FIELD_TYPES.includes(f?.type) ? f.type : 'text',
  }));
}

function passwordHistory(v: unknown): PasswordHistoryEntry[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((h: any) => typeof h?.password === 'string' && h.password.length <= LIMITS.password)
    .slice(0, 10)
    .map((h: any) => ({ password: h.password, changedAt: isoDate(h.changedAt) || new Date().toISOString() }));
}

function icon(v: any): ServiceIcon {
  if (v?.kind === 'glyph' && typeof v.glyph === 'string' && v.glyph.length <= 40) {
    return { kind: 'glyph', glyph: v.glyph, color: typeof v.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.color) ? v.color : undefined };
  }
  // Só imagens embutidas (data URI) e pequenas: uma URL externa vazaria o uso do cofre para um servidor
  if (v?.kind === 'image' && typeof v.image === 'string' && v.image.length <= MAX_ICON_IMAGE && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(v.image)) {
    return { kind: 'image', image: v.image };
  }
  return { kind: 'auto' };
}

function category(v: unknown, url: string, title: string): CredentialCategory {
  if (typeof v === 'string' && v in CategoryLabels) return v as CredentialCategory;
  const s = CategoryService.suggest(url, title);
  return s.confidence === 'baixa' ? 'other' : s.category;
}

function positiveInt(v: unknown, max: number): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= max ? n : null;
}

const ANDROID_PKG = /^[a-z]\w*(?:\.[a-z]\w*)+$/i;

/**
 * Só http(s) ou endereço sem esquema. Um arquivo forjado poderia trazer intent://, file://, content:// ou
 * javascript:, que abririam outro app ou um arquivo local ao tocar no endereço. androidapp://pacote
 * (Bitwarden) vira o app Android associado.
 */
export function safeUrl(raw: string): { url: string; androidPackage: string | null } {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (!m) return { url: raw, androidPackage: null };
  const scheme = m[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https') return { url: raw, androidPackage: null };
  if (scheme === 'androidapp') {
    const pkg = raw.slice(m[0].length).replace(/^\/\//, '').split(/[/?#]/)[0];
    return { url: '', androidPackage: ANDROID_PKG.test(pkg) ? pkg.slice(0, 255) : null };
  }
  // "site.com:8080" e "localhost:3000" não são esquema: depois dos dois-pontos vem a porta
  if (/^[\w.-]+:\d+(?:[/?#]|$)/.test(raw)) return { url: raw, androidPackage: null };
  return { url: '', androidPackage: null };
}

function withPackage(list: string[], pkg: string | null): string[] {
  return pkg && !list.includes(pkg) && list.length < MAX_DOMAINS ? [...list, pkg] : list;
}

/** Credencial vinda de arquivo → campos aceitos (sem id, pasta e datas internas de atualização). */
export function sanitizeCredential(raw: Partial<Credential>): Partial<Credential> {
  const r: any = raw || {};
  const title = limited(str(r.title).trim(), LIMITS.title, 'título');
  const username = limited(r.username, LIMITS.username, 'usuário');
  const password = limited(r.password, LIMITS.password, 'senha');
  const { url, androidPackage } = safeUrl(limited(str(r.url).trim(), LIMITS.url, 'site'));
  const notes = limited(r.notes, LIMITS.notes, 'notas');
  if (!title) throw new SanitizeError('sem título, usuário ou site');
  if (!password && !username && !url) throw new SanitizeError('linha sem usuário, senha ou site');
  const out: Partial<Credential> = {
    title,
    username,
    password,
    url,
    notes,
    category: category(r.category, url, title),
    favorite: r.favorite === true,
    customFields: customFields(r.customFields),
    icon: icon(r.icon),
    passwordHistory: passwordHistory(r.passwordHistory),
    associatedDomains: stringList(r.associatedDomains, MAX_DOMAINS, 253),
    androidPackages: withPackage(stringList(r.androidPackages, MAX_DOMAINS, 255), androidPackage),
    expiresAt: anyDate(r.expiresAt),
    inactive: r.inactive === true,
    maxPasswordAgeDays: positiveInt(r.maxPasswordAgeDays, 3650),
    usageCount: positiveInt(r.usageCount, 1e7) ?? 0,
    lastUsedAt: isoDate(r.lastUsedAt),
  };
  const createdAt = isoDate(r.createdAt);
  if (createdAt) out.createdAt = createdAt;
  const changedAt = isoDate(r.passwordChangedAt);
  if (changedAt) out.passwordChangedAt = changedAt;
  return out;
}

const NOTE_CATEGORIES = Object.keys(NoteCategoryLabels) as NoteCategory[];

function attachments(v: unknown): NoteAttachment[] {
  if (!Array.isArray(v)) return [];
  if (v.length > NOTE_LIMITS.attachments) throw new SanitizeError(`use no máximo ${NOTE_LIMITS.attachments} anexos por nota`);
  let total = 0;
  return v.map((a: any, i: number) => {
    const data = str(a?.data);
    if (!/^[A-Za-z0-9+/=]*$/.test(data)) throw new SanitizeError('anexo com conteúdo inválido');
    total += data.length;
    if (total > NOTE_LIMITS.attachmentsBytes) throw new SanitizeError('os anexos da nota são grandes demais');
    return {
      id: typeof a?.id === 'string' && a.id.length <= 64 ? a.id : `a${i}-${Date.now()}`,
      name: limited(a?.name, NOTE_LIMITS.attachmentName, 'nome do anexo') || 'anexo',
      mime: /^[\w.+-]+\/[\w.+-]+$/.test(str(a?.mime)) ? str(a.mime) : 'application/octet-stream',
      size: Math.floor((data.length * 3) / 4),
      data,
    };
  });
}

export function sanitizeNote(raw: Partial<SecureNote>): Partial<SecureNote> {
  const r: any = raw || {};
  const title = limited(str(r.title).trim(), LIMITS.title, 'título');
  if (!title) throw new SanitizeError('nota sem título');
  const out: Partial<SecureNote> = {
    title,
    content: limited(r.content, NOTE_LIMITS.content, 'conteúdo da nota'),
    category: NOTE_CATEGORIES.includes(r.category) ? r.category : 'other',
    favorite: r.favorite === true,
    attachments: attachments(r.attachments),
  };
  const createdAt = isoDate(r.createdAt);
  if (createdAt) out.createdAt = createdAt;
  return out;
}

const FORM_FIELDS: Record<FormItem['kind'], string[]> = {
  card: ['label', 'holder', 'number', 'expMonth', 'expYear', 'cvv', 'brand'],
  address: ['label', 'fullName', 'zipCode', 'street', 'number', 'complement', 'neighborhood', 'city', 'state', 'country', 'phone'],
  identity: ['label', 'fullName', 'email', 'phone', 'cpf', 'rg', 'birthDate', 'company'],
};
const CARD_BRANDS = ['visa', 'mastercard', 'elo', 'amex', 'hipercard', 'diners', 'other'];

export function sanitizeForm(raw: Partial<FormItem>): Partial<FormItem> {
  const r: any = raw || {};
  const kind = r.kind as FormItem['kind'];
  if (!FORM_FIELDS[kind]) throw new SanitizeError('formulário de tipo desconhecido');
  const out: any = { kind };
  for (const f of FORM_FIELDS[kind]) out[f] = limited(r[f], FORM_FIELD_MAX, f).trim();
  if (!out.label) throw new SanitizeError('formulário sem nome');
  if (kind === 'card' && !CARD_BRANDS.includes(out.brand)) out.brand = 'other';
  if (kind === 'address') out.isPrimary = r.isPrimary === true;
  const createdAt = isoDate(r.createdAt);
  if (createdAt) out.createdAt = createdAt;
  return out;
}
