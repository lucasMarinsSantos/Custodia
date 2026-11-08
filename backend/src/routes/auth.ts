// Conta e sessão.
// O aparelho nunca envia a senha mestra nem a DEK. Ele deriva, da chave de sincronização (32 bytes
// aleatórios, compartilhada só entre os aparelhos pelo código de pareamento):
//   accountId  = HKDF(chave, "account-id")  → identifica a conta
//   authSecret = HKDF(chave, "auth")        → prova a posse da chave; o servidor guarda scrypt(authSecret)
// Nenhum dos dois permite recuperar a chave (HKDF é unidirecional).
import { randomBytes } from 'crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import type { Config } from '../config';
import type { DB } from '../db';
import { dummyHash, hashSecret, verifySecret } from '../secrets';
import { ACCOUNT_ID_RE, AUTH_SECRET_RE, DEVICE_ID_RE, cleanDeviceName, matches } from '../validate';

const AUDIENCE = 'custodia-sync';
const MSG_DEVICE_REVOKED = 'Este aparelho foi desconectado da conta. Pareie-o novamente.';

export interface AuthInfo {
  accountId: string;
  deviceId: string;
}

export interface AuthedRequest extends Request {
  auth?: AuthInfo;
}

/** Express 4 não captura rejeições de handlers async: encaminha o erro ao middleware de erro. */
export const asyncHandler =
  (fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: AuthedRequest, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

const tooMany = { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' };

interface DeviceRow {
  revoked_at: string | null;
}

/** Middleware: exige um JWT válido de um aparelho ainda ativo na conta. */
export function requireAuth(config: Config, db: DB) {
  const findDevice = db.prepare('SELECT revoked_at FROM devices WHERE account_id = ? AND id = ?');
  const touch = db.prepare('UPDATE devices SET last_seen_at = ? WHERE account_id = ? AND id = ?');
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Sessão ausente. Entre novamente.' });
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], audience: AUDIENCE }) as jwt.JwtPayload;
    } catch {
      return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
    }
    const accountId = payload.sub;
    const deviceId = payload.did;
    if (!matches(ACCOUNT_ID_RE, accountId) || !matches(DEVICE_ID_RE, deviceId)) {
      return res.status(401).json({ error: 'Sessão inválida.' });
    }
    const device = findDevice.get(accountId, deviceId) as DeviceRow | undefined;
    // Aparelho revogado (ou conta apagada): o token deixa de valer na hora, mesmo antes de expirar.
    if (!device || device.revoked_at) return res.status(401).json({ error: MSG_DEVICE_REVOKED, code: 'device_revoked' });
    touch.run(new Date().toISOString(), accountId, deviceId);
    req.auth = { accountId, deviceId };
    next();
  };
}

export function authRouter(config: Config, db: DB): Router {
  const router = Router();
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.rateLimits.login, standardHeaders: true, legacyHeaders: false, message: tooMany });
  const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: config.rateLimits.register, standardHeaders: true, legacyHeaders: false, message: tooMany });

  const getAccount = db.prepare('SELECT auth_hash FROM accounts WHERE id = ?');
  const insertAccount = db.prepare('INSERT INTO accounts (id, auth_hash, seq, epoch, created_at) VALUES (?, ?, 0, ?, ?)');
  const getDevice = db.prepare('SELECT revoked_at FROM devices WHERE account_id = ? AND id = ?');
  const countDevices = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND revoked_at IS NULL');
  const insertDevice = db.prepare('INSERT INTO devices (account_id, id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)');
  const renameDevice = db.prepare('UPDATE devices SET name = ?, last_seen_at = ? WHERE account_id = ? AND id = ?');

  router.post(
    '/register',
    registerLimiter,
    asyncHandler(async (req, res) => {
      const { accountId, authSecret } = req.body || {};
      if (!matches(ACCOUNT_ID_RE, accountId) || !matches(AUTH_SECRET_RE, authSecret)) {
        return res.status(400).json({ error: 'Campos obrigatórios: accountId (32 hex) e authSecret (64 hex)' });
      }
      if (getAccount.get(accountId)) return res.status(409).json({ error: 'Conta já existe' });
      const hash = await hashSecret(authSecret);
      try {
        insertAccount.run(accountId, hash, randomBytes(16).toString('hex'), new Date().toISOString());
      } catch (e: unknown) {
        // Dois cadastros simultâneos passam pela checagem acima; a chave primária decide.
        if (String((e as { code?: string })?.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Conta já existe' });
        throw e;
      }
      res.status(201).json({ accountId });
    }),
  );

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const { accountId, authSecret, device } = req.body || {};
      const deviceName = cleanDeviceName(device?.name);
      if (!matches(ACCOUNT_ID_RE, accountId) || !matches(AUTH_SECRET_RE, authSecret) || !matches(DEVICE_ID_RE, device?.id) || !deviceName) {
        return res.status(400).json({ error: 'Campos obrigatórios: accountId, authSecret e device { id, name }' });
      }
      const row = getAccount.get(accountId) as { auth_hash: string } | undefined;
      const ok = await verifySecret(authSecret, row ? row.auth_hash : await dummyHash());
      if (!row || !ok) return res.status(401).json({ error: 'Conta não encontrada ou código de pareamento incorreto.' });

      const now = new Date().toISOString();
      const existing = getDevice.get(accountId, device.id) as DeviceRow | undefined;
      if (existing?.revoked_at) return res.status(403).json({ error: MSG_DEVICE_REVOKED, code: 'device_revoked' });
      if (existing) {
        renameDevice.run(deviceName, now, accountId, device.id);
      } else {
        const { n } = countDevices.get(accountId) as { n: number };
        if (n >= config.limits.maxDevicesPerAccount) {
          return res.status(403).json({ error: `Limite de ${config.limits.maxDevicesPerAccount} aparelhos por conta atingido. Desconecte um aparelho antes.` });
        }
        insertDevice.run(accountId, device.id, deviceName, now, now);
      }
      const token = jwt.sign({ did: device.id }, config.jwtSecret, {
        algorithm: 'HS256',
        audience: AUDIENCE,
        subject: accountId,
        expiresIn: config.tokenTtlSeconds,
      });
      res.json({ token, expiresIn: config.tokenTtlSeconds, accountId, deviceId: device.id });
    }),
  );

  /** Apaga a conta, os aparelhos e todos os blocos cifrados do servidor. */
  router.delete('/account', requireAuth(config, db), (req: AuthedRequest, res: Response) => {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(req.auth!.accountId);
    res.status(204).end();
  });

  return router;
}
