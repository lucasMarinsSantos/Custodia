// Envelope cifrado por senha para arquivos exportados ( exportação cifrada, inventário com senha)
//
// Formato (JSON legível só no cabeçalho):
//   {
//     "format": "custodia-encrypted", "version": 1,
//     "kind": "export" | "inventory",
//     "kdf": { "name": "PBKDF2-HMAC-SHA256", "iterations": 310000, "salt": "<base64 16 bytes>" },
//     "cipher": "AES-256-GCM",
//     "createdAt": "<ISO>",
//     "data": "<base64: versão(1) | nonce(12) | texto cifrado + tag(16)>"
//   }
// A chave é PBKDF2(senha, salt) com o mesmo padrão de src/crypto. O cabeçalho inteiro (formato, tipo, KDF e data)
// entra como dado autenticado (AAD) do GCM: trocar qualquer campo, inclusive baixar as iterações, invalida o arquivo.

import { aesDecrypt, aesEncrypt, deriveKey, fromB64, fromUtf8, PBKDF2_ITERATIONS, randomBytes, randomInt, toB64, utf8, wipe } from '../../crypto';
import { MasterPasswordPolicy } from '../VaultService';

export const ENCRYPTED_FORMAT = 'custodia-encrypted' as const;
export type EnvelopeKind = 'export' | 'inventory';

/** Iterações aceitas ao abrir: abaixo disso o arquivo foi adulterado (ou é fraco demais para confiar). */
export const MIN_IMPORT_ITERATIONS = 100000;
export const MAX_IMPORT_ITERATIONS = 5000000;
/** Tamanho mínimo da senha definida pelo usuário para o arquivo. */
export const MIN_FILE_PASSWORD = 12;

export interface EncryptedEnvelope {
  format: typeof ENCRYPTED_FORMAT;
  version: 1;
  kind: EnvelopeKind;
  kdf: { name: 'PBKDF2-HMAC-SHA256'; iterations: number; salt: string };
  cipher: 'AES-256-GCM';
  createdAt: string;
  data: string;
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Falha na descriptografia. Senha inválida.');
  }
}

function aadOf(e: Pick<EncryptedEnvelope, 'format' | 'version' | 'kind' | 'kdf' | 'cipher' | 'createdAt'>): Uint8Array {
  return utf8([e.format, e.version, e.kind, e.kdf.name, e.kdf.iterations, e.kdf.salt, e.cipher, e.createdAt].join('|'));
}

/** Senha temporária forte: 6 grupos de 4 caracteres sem ambiguidade (32 símbolos → 120 bits). */
export function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groups: string[] = [];
  for (let g = 0; g < 6; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[randomInt(alphabet.length)];
    groups.push(s);
  }
  return groups.join('-');
}

/** Valida a senha escolhida pelo usuário para o arquivo (mínimo 12 caracteres e fora da lista de senhas comuns). */
export function filePasswordError(pw: string): string | null {
  if (pw.length < MIN_FILE_PASSWORD) return `A senha do arquivo deve ter pelo menos ${MIN_FILE_PASSWORD} caracteres`;
  if (MasterPasswordPolicy.isCommon(pw)) return 'Esta senha é comum demais e foi rejeitada';
  return null;
}

export async function encryptEnvelope(plaintext: string, password: string, kind: EnvelopeKind, iterations = PBKDF2_ITERATIONS): Promise<EncryptedEnvelope> {
  const salt = randomBytes(16);
  const header = {
    format: ENCRYPTED_FORMAT,
    version: 1 as const,
    kind,
    kdf: { name: 'PBKDF2-HMAC-SHA256' as const, iterations, salt: toB64(salt) },
    cipher: 'AES-256-GCM' as const,
    createdAt: new Date().toISOString(),
  };
  const key = await deriveKey(password, salt, iterations);
  try {
    return { ...header, data: toB64(aesEncrypt(key, utf8(plaintext), aadOf(header))) };
  } finally {
    wipe(key);
  }
}

export function isEncryptedEnvelope(obj: any): obj is EncryptedEnvelope {
  return !!obj && typeof obj === 'object' && obj.format === ENCRYPTED_FORMAT;
}

/** Abre o envelope. Senha errada ou arquivo adulterado: "Falha na descriptografia. Senha inválida." */
export async function decryptEnvelope(env: EncryptedEnvelope, password: string, opts: { minIterations?: number } = {}): Promise<string> {
  const iter = Number(env?.kdf?.iterations);
  const min = opts.minIterations ?? MIN_IMPORT_ITERATIONS;
  if (env.version !== 1 || env.cipher !== 'AES-256-GCM' || env.kdf?.name !== 'PBKDF2-HMAC-SHA256' || typeof env.data !== 'string' || typeof env.kdf.salt !== 'string') {
    throw new Error('Arquivo cifrado em formato desconhecido');
  }
  // Iterações baixas permitiriam força bruta rápida num arquivo forjado; altas demais travariam o app
  if (!Number.isInteger(iter) || iter < min || iter > MAX_IMPORT_ITERATIONS) throw new Error('Parâmetros de derivação de chave inválidos');
  const key = await deriveKey(password, fromB64(env.kdf.salt), iter);
  try {
    return fromUtf8(aesDecrypt(key, fromB64(env.data), aadOf(env)));
  } catch {
    throw new WrongPasswordError();
  } finally {
    wipe(key);
  }
}
