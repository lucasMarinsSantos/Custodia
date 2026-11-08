// Custódia: servidor de sincronização zero-knowledge.
// createApp monta o Express sem abrir porta (os testes usam supertest; server.ts sobe o servidor).
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { Config } from './config';
import type { DB } from './db';
import { authRouter, requireAuth } from './routes/auth';
import { devicesRouter } from './routes/devices';
import { syncRouter } from './routes/sync';

export const VERSION = '2.0.0';

export function createApp(config: Config, db: DB) {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  // CORS fechado: o app móvel não envia Origin. Requisição de navegador (inclusive o preflight) é recusada,
  // para que nenhuma página consiga usar o servidor com um token roubado ou fazer cadastros em massa.
  app.use((req, res, next) => {
    if (req.headers.origin !== undefined) return res.status(403).json({ error: 'Origem não permitida' });
    next();
  });

  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: config.rateLimits.api,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Muitas requisições. Tente novamente em instantes.' },
    }),
  );

  // Corpo grande só no push (blocos cifrados); o resto aceita no máximo 16 KB.
  const pushLimit = Math.max(1024 * 1024, Math.ceil(config.limits.maxCiphertextChars * 1.1) * Math.min(config.limits.maxPushItems, 8));
  const pushBody = express.json({ limit: pushLimit });
  const smallBody = express.json({ limit: '16kb' });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', app: 'Custódia Sync', version: VERSION });
  });

  const auth = requireAuth(config, db);
  app.use('/api/auth', smallBody, authRouter(config, db));
  app.use('/api/devices', smallBody, auth, devicesRouter(db));
  // A autenticação vem antes da leitura do corpo grande: sem token, o servidor nem lê os megabytes.
  app.use('/api/sync', auth);
  app.use('/api/sync/push', pushBody);
  app.use('/api/sync', smallBody, syncRouter(config, db));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada' });
  });

  app.use((err: Error & { type?: string }, req: Request, res: Response, _next: NextFunction) => {
    // Erros do body-parser são do cliente, não do servidor.
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requisição grande demais' });
    // Nada do corpo da requisição vai para o log (pode conter segredos de autenticação).
    console.error(JSON.stringify({ level: 'error', msg: err.message, method: req.method, path: req.path }));
    res.status(500).json({ error: 'Erro interno do servidor' });
  });

  return app;
}
