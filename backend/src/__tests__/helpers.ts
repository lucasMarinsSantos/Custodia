// Utilitários dos testes: app isolado (banco em memória) e clientes simulados.
import { createHash, randomBytes } from 'crypto';
import request from 'supertest';
import { createApp } from '../app';
import { loadConfig, type Config, type Limits, type RateLimits } from '../config';
import { openDatabase, type DB } from '../db';
import type { Express } from 'express';

export function makeApp(overrides: { limits?: Partial<Limits>; rateLimits?: Partial<RateLimits>; tokenTtlSeconds?: number } = {}): { app: Express; db: DB; config: Config } {
  const base = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'segredo-de-teste-com-mais-de-32-caracteres' });
  const config: Config = {
    ...base,
    ...overrides,
    limits: { ...base.limits, ...overrides.limits },
    rateLimits: { login: 1000, register: 1000, api: 100000, ...overrides.rateLimits },
  };
  const db = openDatabase(':memory:');
  return { app: createApp(config, db), db, config };
}

/** Conta simulada: no app, accountId e authSecret saem de HKDF(chave de sync). Aqui basta serem aleatórios. */
export function newAccount() {
  const key = randomBytes(32);
  const h = (label: string) => createHash('sha256').update(label).update(key).digest('hex');
  return { accountId: h('account').slice(0, 32), authSecret: h('auth') };
}

export const deviceId = () => randomBytes(8).toString('hex');

/** Bloco no formato do app: versão(1) + nonce(12) + ciphertext + tag(16), em base64. */
export const blob = (bytes = 64) => Buffer.concat([Buffer.from([1]), randomBytes(12 + bytes + 16)]).toString('base64');

let clock = 1_700_000_000_000;
export const hlc = (node = 'node1') => `${String(clock++).padStart(15, '0')}:000000:${node}`;

export async function login(app: Parameters<typeof request>[0], acc: { accountId: string; authSecret: string }, id = deviceId(), name = 'Aparelho') {
  const r = await request(app).post('/api/auth/login').send({ ...acc, device: { id, name } });
  return { status: r.status, body: r.body, token: r.body.token as string, deviceId: id };
}

export async function registerAndLogin(app: Parameters<typeof request>[0], name = 'Celular') {
  const acc = newAccount();
  await request(app).post('/api/auth/register').send(acc).expect(201);
  const dev = await login(app, acc, deviceId(), name);
  expect(dev.status).toBe(200);
  return { acc, ...dev };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
