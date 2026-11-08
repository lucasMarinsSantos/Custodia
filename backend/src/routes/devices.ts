// Aparelhos da conta: listagem e revogação.
import { Router, type Response } from 'express';
import type { DB } from '../db';
import type { AuthedRequest } from './auth';
import { DEVICE_ID_RE, matches } from '../validate';

interface DeviceRow {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string;
}

export function devicesRouter(db: DB): Router {
  const router = Router();
  const list = db.prepare(
    'SELECT id, name, created_at, last_seen_at FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at ASC',
  );
  const revoke = db.prepare('UPDATE devices SET revoked_at = ? WHERE account_id = ? AND id = ? AND revoked_at IS NULL');

  router.get('/', (req: AuthedRequest, res: Response) => {
    const { accountId, deviceId } = req.auth!;
    const rows = list.all(accountId) as DeviceRow[];
    res.json({
      devices: rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === deviceId })),
    });
  });

  /** Revoga um aparelho (inclusive o próprio, ao desconectar). Seus tokens deixam de valer na hora. */
  router.delete('/:id', (req: AuthedRequest, res: Response) => {
    const id = req.params.id;
    if (!matches(DEVICE_ID_RE, id)) return res.status(400).json({ error: 'Id de aparelho inválido' });
    // O filtro por account_id garante que um usuário não revoga aparelhos de outra conta.
    const info = revoke.run(new Date().toISOString(), req.auth!.accountId, id);
    if (!info.changes) return res.status(404).json({ error: 'Aparelho não encontrado' });
    res.status(204).end();
  });

  return router;
}
