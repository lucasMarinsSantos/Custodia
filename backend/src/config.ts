// Configuração do servidor (variáveis de ambiente) e limites de uso.
// Tudo que vem do ambiente é validado aqui, uma vez, na subida do processo.
import { randomBytes } from 'crypto';

export interface Limits {
  /** Tamanho máximo do `ciphertext` (base64) de um documento. */
  maxCiphertextChars: number;
  /** Mudanças aceitas em um único push. */
  maxPushItems: number;
  /** Documentos (inclusive lápides) por conta. */
  maxDocsPerAccount: number;
  /** Bytes cifrados guardados por conta. */
  maxBytesPerAccount: number;
  /** Aparelhos ativos por conta. */
  maxDevicesPerAccount: number;
  /** Máximo de mudanças por página do pull. */
  maxPullLimit: number;
  /** Bytes de ciphertext por página do pull (sempre devolve ao menos uma mudança). */
  maxPullPageBytes: number;
}

export interface RateLimits {
  /** Janela de 15 min: tentativas de login por IP. */
  login: number;
  /** Janela de 1 h: cadastros por IP. */
  register: number;
  /** Janela de 1 min: requisições gerais por IP. */
  api: number;
}

export interface Config {
  port: number;
  dbFile: string;
  jwtSecret: string;
  /** Vida do JWT em segundos (curta: o app renova com o segredo derivado da chave de sync). */
  tokenTtlSeconds: number;
  trustProxy: boolean;
  limits: Limits;
  rateLimits: RateLimits;
}

export const DEFAULT_LIMITS: Limits = {
  maxCiphertextChars: 1024 * 1024,
  maxPushItems: 200,
  maxDocsPerAccount: 10000,
  maxBytesPerAccount: 100 * 1024 * 1024,
  maxDevicesPerAccount: 20,
  maxPullLimit: 500,
  maxPullPageBytes: 4 * 1024 * 1024,
};

export const DEFAULT_RATE_LIMITS: RateLimits = { login: 20, register: 10, api: 600 };

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} deve ser um inteiro positivo`);
  return n;
}

/** Lê a configuração do ambiente. Em produção, JWT_SECRET (32+ caracteres) é obrigatório. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  let jwtSecret = env.JWT_SECRET || '';
  if (production && jwtSecret.length < 32) {
    // Um segredo efêmero invalidaria as sessões a cada reinício; um segredo curto pode ser adivinhado.
    throw new Error('JWT_SECRET é obrigatório em produção e precisa ter pelo menos 32 caracteres');
  }
  if (!jwtSecret) jwtSecret = randomBytes(32).toString('hex');
  return {
    port: intEnv(env, 'PORT', 3000),
    dbFile: env.CUSTODIA_DB || 'custodia-sync.sqlite',
    jwtSecret,
    tokenTtlSeconds: intEnv(env, 'TOKEN_TTL_SECONDS', 15 * 60),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    limits: {
      ...DEFAULT_LIMITS,
      maxDocsPerAccount: intEnv(env, 'MAX_DOCS_PER_ACCOUNT', DEFAULT_LIMITS.maxDocsPerAccount),
      maxBytesPerAccount: intEnv(env, 'MAX_BYTES_PER_ACCOUNT', DEFAULT_LIMITS.maxBytesPerAccount),
      maxDevicesPerAccount: intEnv(env, 'MAX_DEVICES_PER_ACCOUNT', DEFAULT_LIMITS.maxDevicesPerAccount),
    },
    rateLimits: {
      login: intEnv(env, 'RATE_LOGIN_PER_15MIN', DEFAULT_RATE_LIMITS.login),
      register: intEnv(env, 'RATE_REGISTER_PER_HOUR', DEFAULT_RATE_LIMITS.register),
      api: intEnv(env, 'RATE_API_PER_MIN', DEFAULT_RATE_LIMITS.api),
    },
  };
}
