// Protocolo do canal entre o app e a extensão "Custódia Connect"
//
// Esta é a versão do app (TypeScript, @noble). A extensão tem a versão gêmea em `browser-extension/protocol.js`
// (Web Crypto). As duas são testadas uma contra a outra no Jest (`integracao-extensao.test.ts`): qualquer mudança
// aqui precisa ser repetida lá.
//
// Pareamento com código de 6 dígitos sem MITM (comparação de código com compromisso, como no Bluetooth
// "numeric comparison" e no ZRTP). O código não é um segredo digitado: ele é derivado das chaves dos dois lados e
// o usuário confere no celular que é o mesmo mostrado na extensão.
//  1. extensão → app  POST /v1/pair/start  { v, name, commit = SHA-256(rótulo ‖ pkE ‖ nE) }
//  2. app → extensão  { pairId, pk = pkP, nonce = nP }                       (o app ainda não sabe pkE)
//  3. extensão → app  POST /v1/pair/finish { pairId, pk = pkE, nonce = nE }   (o app confere o compromisso)
//  4. os dois calculam código = SHA-256(rótulo ‖ pkE ‖ pkP ‖ nE ‖ nP) mod 10⁶ e o celular pergunta
//     "O código na extensão é 123 456?". Um intermediário precisa fixar a chave dele antes de ver nP (compromisso),
//     então acerta o código com chance de 1 em 1 milhão por tentativa, e cada tentativa exige um toque no celular.
//  5. chave da sessão = HKDF-SHA256(ECDH P-256(pkE, pkP), sal = nE ‖ nP, info = rótulo), 32 bytes, AES-256-GCM.
//     O app responde { sid, expiresAt, proof = HMAC(chave, "paired|sid|expiresAt") }: a extensão confere a prova.
// Pedidos: POST /v1/rpc { sid, iv, ct }, com ct = AES-256-GCM(chave, iv, JSON {op, url, ts, nonce, …},
// dado associado = "rótulo|req|sid"). O app recusa horário fora de ±60 s e nonce repetido. A resposta vem cifrada
// com o dado associado "rótulo|res|sid" e repete o nonce do pedido (`re`), o que a amarra ao pedido.

import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { concatBytes, equalBytes, fromB64, fromUtf8, randomBytes, toB64, utf8 } from '../crypto';

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_LABEL = 'custodia-bridge-v1';
/** Janela aceita entre o relógio do computador e o do celular. */
export const CLOCK_SKEW_MS = 60_000;
/** Tamanho máximo do JSON decifrado de um pedido (o corpo HTTP inteiro é limitado a 64 KiB no Kotlin). */
export const MAX_PLAINTEXT = 16 * 1024;

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const NONCE_RE = /^[A-Za-z0-9+/=_-]{16,64}$/;

export class ProtocolError extends Error {}

/** Base64 com tamanho decodificado exato; lança `ProtocolError` em qualquer outra coisa (entrada da rede). */
export function b64Exact(value: unknown, bytes: number, what: string): Uint8Array {
  if (typeof value !== 'string' || value.length > 200 || !B64_RE.test(value)) throw new ProtocolError(`${what} inválido`);
  const out = fromB64(value);
  if (out.length !== bytes) throw new ProtocolError(`${what} inválido`);
  return out;
}

/** Chave pública P-256 sem compressão (65 bytes, começa com 0x04). */
export function publicKeyFrom(value: unknown): Uint8Array {
  const pk = b64Exact(value, 65, 'Chave pública');
  if (pk[0] !== 4) throw new ProtocolError('Chave pública inválida');
  return pk;
}

const label = (suffix: string) => utf8(`${PROTOCOL_LABEL}|${suffix}`);

export function commitment(pkE: Uint8Array, nE: Uint8Array): Uint8Array {
  return sha256(concatBytes(label('commit'), pkE, nE));
}

/** Código de 6 dígitos que os dois lados mostram (sem operações bit a bit: regra do lint fora de src/crypto). */
export function pairingCode(pkE: Uint8Array, pkP: Uint8Array, nE: Uint8Array, nP: Uint8Array): string {
  const h = sha256(concatBytes(label('sas'), pkE, pkP, nE, nP));
  const n = ((h[0] * 256 + h[1]) * 256 + h[2]) * 256 + h[3];
  return String(n % 1_000_000).padStart(6, '0');
}

export function sessionKey(shared: Uint8Array, nE: Uint8Array, nP: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concatBytes(nE, nP), label('key'), 32);
}

export function pairingProof(key: Uint8Array, sid: string, expiresAt: number): string {
  return toB64(hmac(sha256, key, label(`paired|${sid}|${expiresAt}`)));
}

export function verifyPairingProof(key: Uint8Array, sid: string, expiresAt: number, proof: unknown): boolean {
  if (typeof proof !== 'string' || !B64_RE.test(proof)) return false;
  return equalBytes(fromB64(proof), hmac(sha256, key, label(`paired|${sid}|${expiresAt}`)));
}

export interface Envelope {
  iv: string;
  ct: string;
}

/** Cifra uma mensagem do canal. `dir` separa pedido e resposta (um não pode ser reaproveitado como o outro). */
export function seal(key: Uint8Array, sid: string, dir: 'req' | 'res', message: object): Envelope {
  const iv = randomBytes(12);
  const ct = gcm(key, iv, label(`${dir}|${sid}`)).encrypt(utf8(JSON.stringify(message)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

/** Decifra e autentica. Lança `ProtocolError` se o envelope foi alterado, é de outra sessão ou da outra direção. */
export function open(key: Uint8Array, sid: string, dir: 'req' | 'res', env: unknown): any {
  const e = env as Partial<Envelope> | null;
  const iv = b64Exact(e?.iv, 12, 'Envelope');
  if (typeof e?.ct !== 'string' || e.ct.length > (MAX_PLAINTEXT * 4) / 3 + 64 || !B64_RE.test(e.ct)) throw new ProtocolError('Envelope inválido');
  let plain: Uint8Array;
  try {
    plain = gcm(key, iv, label(`${dir}|${sid}`)).decrypt(fromB64(e.ct));
  } catch {
    throw new ProtocolError('Mensagem não autenticada');
  }
  try {
    const obj = JSON.parse(fromUtf8(plain));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('não é objeto');
    return obj;
  } catch {
    throw new ProtocolError('Mensagem inválida');
  }
}

// -----------------------------------------------------------------------------
// Proteção contra repetição (replay)
// -----------------------------------------------------------------------------
const MAX_SEEN = 500;

/** Nonces já vistos por sessão, guardados pelo tempo da janela de horário. */
export class ReplayGuard {
  private seen = new Map<string, number>();

  /** true quando o pedido é novo e está dentro da janela; registra o nonce. */
  accept(sid: string, nonce: unknown, ts: unknown, now = Date.now()): boolean {
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce) || typeof ts !== 'number' || !Number.isFinite(ts)) return false;
    if (Math.abs(now - ts) > CLOCK_SKEW_MS) return false;
    for (const [k, at] of this.seen) if (now - at > 2 * CLOCK_SKEW_MS) this.seen.delete(k);
    const key = `${sid}|${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }

  clear() {
    this.seen.clear();
  }
}
