// Criptografia do app (zero-knowledge)
// AES-256-GCM (envelope da chave do banco), PBKDF2-HMAC-SHA256 (nativo quando disponível) e SHA-256.
// A chave do banco SQLCipher (DEK) é aleatória e nunca é gravada em claro: fica envelopada pela
// senha mestra / métodos de recuperação, e os envelopes ficam em preferências cifradas pelo
// Android Keystore.

import { gcm } from '@noble/ciphers/aes';
import { sha256 } from '@noble/hashes/sha2';
import { pbkdf2 as jsPbkdf2 } from '@noble/hashes/pbkdf2';
import { Security } from '../native';

// ---------------------------------------------------------------------------
// Codificação
// ---------------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toB64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64[i]] = i;
B64_LOOKUP['-'] = 62;
B64_LOOKUP._ = 63;

export function fromB64(str: string): Uint8Array {
  const clean = str.replace(/[^A-Za-z0-9+/\-_]/g, '');
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_LOOKUP[clean[i]] ?? 0;
    const b = B64_LOOKUP[clean[i + 1]] ?? 0;
    const c = B64_LOOKUP[clean[i + 2]] ?? 0;
    const d = B64_LOOKUP[clean[i + 3]] ?? 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < len) out[o++] = (n >> 16) & 255;
    if (o < len && i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (o < len && i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.slice(0, o);
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function utf8(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export function fromUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    let c: number;
    if (b < 0x80) c = b;
    else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b < 0xf0) c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    if (c > 0xffff) {
      c -= 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023));
    } else out += String.fromCharCode(c);
  }
  return out;
}

export function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Sobrescreve um buffer com zeros (higiene de memória). */
export function wipe(bytes?: Uint8Array | null) {
  if (bytes) bytes.fill(0);
}

// ---------------------------------------------------------------------------
// Aleatoriedade
// ---------------------------------------------------------------------------
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const g: any = globalThis as any;
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    g.crypto.getRandomValues(out);
    return out;
  }
  // Nunca usar fonte não criptográfica: sem CSPRNG disponível, falha de forma explícita.
  throw new Error('Gerador aleatório seguro indisponível (react-native-get-random-values não carregado)');
}

export function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
  while (true) {
    const b = randomBytes(4);
    const n = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
    if (n < limit) return n % maxExclusive;
  }
}

export function uuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------
export const sha256Hex = (s: string | Uint8Array) => toHex(sha256(typeof s === 'string' ? utf8(s) : s));
export const sha256Bytes = (b: Uint8Array) => sha256(b);

export const PBKDF2_ITERATIONS = 310000;

/** PBKDF2-HMAC-SHA256. Usa implementação nativa (rápida) e cai para JS se necessário. */
export async function deriveKey(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS, len = 32): Promise<Uint8Array> {
  const pw = utf8(password.normalize ? password.normalize('NFKC') : password);
  const t0 = Date.now();
  try {
    const native = await Security.pbkdf2(toB64(pw), toB64(salt), iterations, len);
    if (native) {
      logSlowKdf('nativo', iterations, t0);
      return fromB64(native);
    }
  } catch (e) {
    console.warn('[crypto] PBKDF2 nativo indisponível, usando a implementação JS:', String((e as Error)?.message || e));
  }
  const out = jsPbkdf2(sha256, pw, salt, { c: iterations, dkLen: len });
  logSlowKdf('js', iterations, t0);
  return out;
}

/** Registra no log (logcat: ReactNativeJS) derivações lentas, para diagnosticar aparelhos/builds lentos. */
function logSlowKdf(impl: string, iterations: number, t0: number) {
  const ms = Date.now() - t0;
  if (ms > 1500) console.log(`[crypto] PBKDF2 ${impl} (${iterations} iterações) levou ${ms} ms`);
}

// ---------------------------------------------------------------------------
// AES-256-GCM
// ---------------------------------------------------------------------------
const VERSION = 1;

/** Cifra bytes: [versão(1) | nonce(12) | ciphertext+tag]. */
export function aesEncrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonce = randomBytes(12);
  const ct = gcm(key, nonce, aad).encrypt(plaintext);
  return concatBytes(new Uint8Array([VERSION]), nonce, ct);
}

export function aesDecrypt(key: Uint8Array, data: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (data.length < 1 + 12 + 16 || data[0] !== VERSION) throw new Error('Formato cifrado inválido');
  const nonce = data.slice(1, 13);
  return gcm(key, nonce, aad).decrypt(data.slice(13));
}

export const encryptString = (key: Uint8Array, text: string, aad?: string) =>
  toB64(aesEncrypt(key, utf8(text), aad ? utf8(aad) : undefined));

export const decryptString = (key: Uint8Array, b64: string, aad?: string) =>
  fromUtf8(aesDecrypt(key, fromB64(b64), aad ? utf8(aad) : undefined));

/** Comparação de tempo constante para strings. */
export function safeEqual(a: string, b: string): boolean {
  return equalBytes(utf8(a), utf8(b));
}
