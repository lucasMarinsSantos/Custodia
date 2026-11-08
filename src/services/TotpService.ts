/* eslint-disable no-bitwise -- HOTP/Base32 dependem de deslocamentos e máscaras de bits (RFC 4226 e RFC 4648) */
// Senhas de uso único baseadas em tempo
//  • HOTP (RFC 4226): HMAC-SHA1(segredo, contador de 8 bytes) → truncamento dinâmico → 6 dígitos
//  • TOTP (RFC 6238): HOTP com contador = floor(tempo Unix / 30 s)
//  • Base32 (RFC 4648) para o segredo, no formato que os apps autenticadores leem do QR Code
//  • URI otpauth://totp/Emissor:conta?secret=...&issuer=... (formato "Key Uri" do Google Authenticator)
//
// Este módulo é puro (sem estado): o armazenamento do segredo, o anti-replay e a contagem de falhas ficam no
// VaultService (verificação em duas etapas do cofre).

import { hmac } from '@noble/hashes/hmac';
import { sha1 } from '@noble/hashes/legacy';
import { randomBytes } from '../crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;
/** Janelas aceitas antes e depois da atual (tolerância de relógio de ±30 s). */
export const TOTP_WINDOW = 1;
/** Tamanho do segredo gerado: 160 bits, o recomendado pela RFC 4226 para HMAC-SHA1. */
export const TOTP_SECRET_BYTES = 20;
/** Limites de entrada (segredos e URIs vêm de fora: QR Code, texto colado). */
const MAX_SECRET_CHARS = 128;
const MAX_URI_CHARS = 512;

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; // evita crescer além de 32 bits
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodifica Base32 (ignora espaços, hífens e o preenchimento "="; aceita minúsculas). */
export function base32Decode(input: string): Uint8Array {
  if (input.length > MAX_SECRET_CHARS) throw new Error('Segredo TOTP grande demais');
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/[=]+$/, '');
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Segredo TOTP inválido (Base32)');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Contador de 8 bytes big-endian (o contador TOTP passa de 32 bits depois de 2106, por isso não usa só bitwise). */
function counterBytes(counter: number): Uint8Array {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c % 256;
    c = Math.floor(c / 256);
  }
  return msg;
}

/** HOTP (RFC 4226, seção 5.3). */
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Contador HOTP inválido');
  const mac = hmac(sha1, key, counterBytes(counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpCounter = (atMs: number, period = TOTP_PERIOD) => Math.floor(atMs / 1000 / period);

export const TotpService = {
  generateSecret(): string {
    return base32Encode(randomBytes(TOTP_SECRET_BYTES));
  },

  /** Código TOTP do instante `at` (ms). */
  generate(secretB32: string, at = Date.now(), digits = TOTP_DIGITS): string {
    return hotp(base32Decode(secretB32), totpCounter(at), digits);
  },

  /** Segundos até o código atual expirar. */
  remaining(at = Date.now()): number {
    return TOTP_PERIOD - (Math.floor(at / 1000) % TOTP_PERIOD);
  },

  /** Só aceita exatamente 6 dígitos (o usuário pode digitar com espaço no meio: "123 456"). */
  normalizeCode(code: string): string | null {
    const c = String(code ?? '').replace(/\s/g, '');
    return /^\d{6}$/.test(c) ? c : null;
  },

  /**
   * Verifica o código na janela atual ±1 e devolve o contador correspondente (ou null).
   * `afterCounter`: anti-replay. Códigos de contador menor ou igual ao último aceito são recusados, mesmo
   * que ainda estejam dentro da janela de tolerância.
   */
  verify(secretB32: string, code: string, opts: { at?: number; afterCounter?: number } = {}): number | null {
    const c = this.normalizeCode(code);
    if (!c) return null;
    const key = base32Decode(secretB32);
    const now = totpCounter(opts.at ?? Date.now());
    let match: number | null = null;
    // Percorre todas as janelas (sem sair cedo) para o tempo não revelar qual delas casou
    for (let w = -TOTP_WINDOW; w <= TOTP_WINDOW; w++) {
      const counter = now + w;
      if (counter < 0) continue;
      const ok = constantTimeEqual(hotp(key, counter), c);
      if (ok && counter > (opts.afterCounter ?? -1) && match === null) match = counter;
    }
    return match;
  },

  /** URI que o app autenticador lê do QR Code. O rótulo é "Emissor:conta", com as partes codificadas. */
  buildUri(secretB32: string, account: string, issuer = 'Custódia'): string {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
    return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}`;
  },

  /** Interpreta uma URI otpauth://totp (QR Code de terceiros): valida esquema, tamanho e parâmetros. */
  parseUri(uri: string): { secret: string; issuer?: string; account?: string; digits: number; period: number } {
    const trimmed = String(uri ?? '').trim();
    if (trimmed.length > MAX_URI_CHARS) throw new Error('QR Code grande demais');
    const m = /^otpauth:\/\/totp\/([^?]*)\?(.*)$/i.exec(trimmed);
    if (!m) throw new Error('O QR Code não contém um código TOTP (otpauth://totp/...)');
    const params = parseQuery(m[2]);
    const secret = (params.get('secret') || '').replace(/\s/g, '').toUpperCase();
    if (!this.isValidSecret(secret)) throw new Error('Segredo TOTP ausente ou inválido');
    const algorithm = (params.get('algorithm') || 'SHA1').toUpperCase();
    const digits = Number(params.get('digits') || TOTP_DIGITS);
    const period = Number(params.get('period') || TOTP_PERIOD);
    if (algorithm !== 'SHA1' || digits !== TOTP_DIGITS || period !== TOTP_PERIOD) {
      throw new Error('Só há suporte a TOTP de 6 dígitos, 30 s e SHA-1');
    }
    const { issuer, account } = parseLabel(safeDecode(m[1]));
    return { secret, issuer: params.get('issuer') || issuer, account, digits, period };
  },

  /** Segredo Base32 válido com pelo menos 80 bits (mínimo da RFC 4226 é 128; 80 é o usual dos serviços). */
  isValidSecret(secret: string): boolean {
    try {
      return base32Decode(secret).length >= 10;
    } catch {
      return false;
    }
  },
};

function parseQuery(q: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const kv of q.split('&')) {
    const [k, v = ''] = kv.split('=');
    if (k) params.set(k.toLowerCase(), safeDecode(v));
  }
  return params;
}

/** Rótulo "Emissor:conta" (o emissor é opcional). */
function parseLabel(label: string): { issuer?: string; account?: string } {
  const sep = label.indexOf(':');
  return { issuer: sep > 0 ? label.slice(0, sep) : undefined, account: (sep >= 0 ? label.slice(sep + 1) : label).trim() || undefined };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Comparação de tempo constante para códigos de mesmo tamanho. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
