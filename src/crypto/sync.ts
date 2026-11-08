// Criptografia da sincronização
//
// Chave de sincronização: 32 bytes aleatórios, gerados no primeiro aparelho. Ela NÃO é a DEK do banco nem
// deriva da senha mestra: só cifra os documentos enviados ao servidor. Fica nas preferências cifradas pelo
// Keystore, separada por perfil.
//
// Dela saem, por HKDF-SHA256 (unidirecional):
//   accountId  (16 bytes, hex) → identifica a conta no servidor
//   authSecret (32 bytes, hex) → prova a posse da chave no login; o servidor guarda só scrypt(authSecret)
// O servidor nunca recebe a chave, a senha mestra nem a DEK.
//
// Pareamento: o aparelho A mostra o código (a chave em base32 + 3 bytes de verificação, 56 caracteres em
// 14 grupos de 4). O aparelho B digita ou cola o código, deriva o mesmo accountId/authSecret e entra na
// mesma conta. O código contém a chave e, por derivação, o id da conta; o servidor não participa da troca.
//
// Cada documento vai cifrado com AES-256-GCM e dados associados (AAD) = coleção + id do documento: o
// servidor não consegue trocar o bloco de um documento pelo de outro sem a decifragem falhar.

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { decryptString, encryptString, equalBytes, randomBytes, toHex, utf8 } from './index';

export const SYNC_KEY_BYTES = 32;
const CHECK_BYTES = 3;
const HKDF_SALT = utf8('custodia-sync-v1');
/** Tamanho do código de pareamento sem os hífens: (32 + 3) bytes × 8 / 5 bits. */
export const PAIRING_CODE_CHARS = ((SYNC_KEY_BYTES + CHECK_BYTES) * 8) / 5;
/** Limite do documento decifrado (proteção contra blocos gigantes vindos do servidor). */
export const MAX_SYNC_PLAINTEXT = 2 * 1024 * 1024;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSyncKey(): Uint8Array {
  return randomBytes(SYNC_KEY_BYTES);
}

function assertKey(key: Uint8Array) {
  if (!(key instanceof Uint8Array) || key.length !== SYNC_KEY_BYTES) throw new Error('Chave de sincronização inválida');
}

/** accountId e authSecret da conta, derivados da chave de sincronização. */
export function deriveSyncAccount(key: Uint8Array): { accountId: string; authSecret: string } {
  assertKey(key);
  return {
    accountId: toHex(hkdf(sha256, key, HKDF_SALT, utf8('account-id'), 16)),
    authSecret: toHex(hkdf(sha256, key, HKDF_SALT, utf8('auth'), 32)),
  };
}

// ---------------------------------------------------------------------------
// Base32 (RFC 4648, sem preenchimento)
// ---------------------------------------------------------------------------
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`Caractere inválido no código: "${ch}"`);
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Código de pareamento
// ---------------------------------------------------------------------------
const checksum = (key: Uint8Array) => sha256(concat(utf8('custodia-pairing'), key)).slice(0, CHECK_BYTES);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Código para digitar no outro aparelho: 14 grupos de 4 caracteres (A–Z e 2–7). */
export function encodePairingCode(key: Uint8Array): string {
  assertKey(key);
  const raw = base32Encode(concat(key, checksum(key)));
  return raw.match(/.{4}/g)!.join('-');
}

/** Normaliza o que o usuário digitou: maiúsculas, sem espaços/hífens e com as trocas comuns (0→O, 1→I, 8→B). */
export function normalizePairingCode(text: string): string {
  return String(text || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/8/g, 'B');
}

/** Lê o código de pareamento e devolve a chave de sincronização (com verificação de digitação). */
export function decodePairingCode(text: string): Uint8Array {
  const clean = normalizePairingCode(text);
  if (clean.length > 200) throw new Error('Código de pareamento grande demais.');
  if (clean.length !== PAIRING_CODE_CHARS) {
    throw new Error(`O código de pareamento tem ${PAIRING_CODE_CHARS} caracteres (sem contar os hífens). Você digitou ${clean.length}.`);
  }
  if (/[^A-Z2-7]/.test(clean)) throw new Error('O código de pareamento só tem letras de A a Z e números de 2 a 7.');
  const bytes = base32Decode(clean);
  const key = bytes.slice(0, SYNC_KEY_BYTES);
  if (!equalBytes(bytes.slice(SYNC_KEY_BYTES, SYNC_KEY_BYTES + CHECK_BYTES), checksum(key))) {
    throw new Error('Código de pareamento incorreto. Confira se não houve erro de digitação.');
  }
  return key;
}

// ---------------------------------------------------------------------------
// Documentos
// ---------------------------------------------------------------------------
export const syncAad = (collection: string, id: string) => `custodia-sync:v1:${collection}:${id}`;

export function encryptSyncDoc(key: Uint8Array, collection: string, id: string, plaintext: string): string {
  assertKey(key);
  return encryptString(key, plaintext, syncAad(collection, id));
}

/** Decifra o bloco; falha se a chave, a coleção ou o id não conferem, ou se o bloco foi alterado. */
export function decryptSyncDoc(key: Uint8Array, collection: string, id: string, b64: string): string {
  assertKey(key);
  if (typeof b64 !== 'string' || b64.length > Math.ceil((MAX_SYNC_PLAINTEXT * 4) / 3) + 64) throw new Error('Bloco cifrado grande demais');
  return decryptString(key, b64, syncAad(collection, id));
}
