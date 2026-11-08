// Hash do segredo de autenticação com scrypt (nativo do Node) e comparação em tempo constante.
// O segredo já tem 256 bits de entropia (HKDF da chave de sincronização no aparelho); o scrypt é
// defesa em profundidade: um vazamento do banco não entrega um valor que sirva para entrar.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scrypt(secret: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(secret, salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Formato: scrypt$N$r$p$salt(b64)$hash(b64). */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(secret, salt, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(secret, Buffer.from(saltB64, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Hash fictício: login de conta inexistente gasta o mesmo tempo (sem enumeração de contas por tempo). */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  if (!dummy) dummy = hashSecret(randomBytes(32).toString('hex'));
  return dummy;
}
