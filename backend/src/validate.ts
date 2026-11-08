// Validação das entradas da API. Tudo que chega do cliente passa por aqui antes de tocar o banco.

/** Coleções sincronizáveis (as mesmas de USER_COLLECTIONS no app). */
export const COLLECTIONS = ['credentials', 'folders', 'notes', 'forms'] as const;
export type SyncCollection = (typeof COLLECTIONS)[number];

/** Id da conta: 128 bits em hex, derivados da chave de sincronização no aparelho (HKDF). */
export const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
/** Segredo de autenticação: 256 bits em hex (HKDF da chave de sincronização). */
export const AUTH_SECRET_RE = /^[0-9a-f]{64}$/;
/** Id do aparelho: aleatório, gerado no próprio aparelho. */
export const DEVICE_ID_RE = /^[a-z0-9]{8,32}$/;
/** Id do documento (UUID no app). */
export const DOC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** HLC: tempo físico (15 dígitos) : contador (6 dígitos) : id do nó. */
export const HLC_RE = /^\d{15}:\d{6}:[a-z0-9]{1,32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** Menor bloco AES-GCM válido no formato do app: versão(1) + nonce(12) + tag(16) = 29 bytes → 40 caracteres. */
const MIN_CIPHERTEXT_CHARS = 40;
export const MAX_DEVICE_NAME = 60;

export const isCollection = (v: unknown): v is SyncCollection => typeof v === 'string' && (COLLECTIONS as readonly string[]).includes(v);
export const matches = (re: RegExp, v: unknown): v is string => typeof v === 'string' && re.test(v);

export function isCiphertext(v: unknown): v is string {
  return typeof v === 'string' && v.length >= MIN_CIPHERTEXT_CHARS && v.length % 4 === 0 && BASE64_RE.test(v);
}

/** Nome do aparelho: texto curto, sem caracteres de controle. */
export function cleanDeviceName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.length >= 1 && name.length <= MAX_DEVICE_NAME ? name : null;
}

/** Inteiro não negativo seguro (cursor, baseSeq). */
export function nonNegativeInt(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export interface PushChange {
  collection: SyncCollection;
  id: string;
  hlc: string;
  ciphertext: string;
  baseSeq: number;
}

/** Valida o corpo do push. Devolve a lista ou a mensagem de erro (400). */
export function parsePush(body: unknown, maxItems: number): PushChange[] | string {
  const changes = (body as { changes?: unknown })?.changes;
  if (!Array.isArray(changes)) return 'Campo obrigatório: changes[]';
  if (changes.length > maxItems) return `Máximo de ${maxItems} mudanças por envio`;
  const seen = new Set<string>();
  const out: PushChange[] = [];
  for (const [i, c] of changes.entries()) {
    const item = c as Record<string, unknown>;
    const baseSeq = nonNegativeInt(item?.baseSeq);
    if (!item || !isCollection(item.collection)) return `changes[${i}].collection inválida`;
    if (!matches(DOC_ID_RE, item.id)) return `changes[${i}].id inválido`;
    if (!matches(HLC_RE, item.hlc)) return `changes[${i}].hlc inválido`;
    if (!isCiphertext(item.ciphertext)) return `changes[${i}].ciphertext deve ser um bloco cifrado em base64`;
    if (baseSeq === null) return `changes[${i}].baseSeq inválido`;
    const key = `${item.collection}/${item.id}`;
    if (seen.has(key)) return `Documento repetido no mesmo envio: ${key}`;
    seen.add(key);
    out.push({ collection: item.collection, id: item.id, hlc: item.hlc, ciphertext: item.ciphertext, baseSeq });
  }
  return out;
}
