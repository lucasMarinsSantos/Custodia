// Sincronização: servidor "cego" de blocos cifrados.
//
// Cada documento guarda o último estado CRDT cifrado enviado (o servidor não decifra nem interpreta).
// A fusão (LWW por campo com HLC) acontece nos aparelhos. Para que nenhum envio apague outro, o push
// usa controle de concorrência otimista: cada mudança informa o `baseSeq` (a versão do servidor que o
// aparelho já fundiu). Se o documento mudou desde então, a mudança volta como conflito; o aparelho faz
// pull, funde e reenvia. Assim o estado guardado é sempre a fusão de todos os envios aceitos.
import { Router, type Response } from 'express';
import type { Config } from '../config';
import type { DB } from '../db';
import type { AuthedRequest } from './auth';
import { nonNegativeInt, parsePush, type PushChange } from '../validate';

interface DocRow {
  seq: number;
  size: number;
}

interface PullRow {
  collection: string;
  doc_id: string;
  hlc: string;
  ciphertext: string;
  seq: number;
}

type Ref = { collection: string; id: string };

export function syncRouter(config: Config, db: DB): Router {
  const router = Router();
  const { limits } = config;

  const accountSeq = db.prepare('SELECT seq FROM accounts WHERE id = ?');
  const accountEpoch = db.prepare('SELECT epoch FROM accounts WHERE id = ?');
  const setAccountSeq = db.prepare('UPDATE accounts SET seq = ? WHERE id = ?');
  const usage = db.prepare('SELECT COUNT(*) AS docs, COALESCE(SUM(size), 0) AS bytes FROM docs WHERE account_id = ?');
  const getDoc = db.prepare('SELECT seq, size FROM docs WHERE account_id = ? AND collection = ? AND doc_id = ?');
  const upsert = db.prepare(
    `INSERT INTO docs (account_id, collection, doc_id, hlc, ciphertext, size, seq, device_id, updated_at)
     VALUES (@account, @collection, @id, @hlc, @ciphertext, @size, @seq, @device, @now)
     ON CONFLICT(account_id, collection, doc_id) DO UPDATE SET
       hlc = excluded.hlc, ciphertext = excluded.ciphertext, size = excluded.size, seq = excluded.seq,
       device_id = excluded.device_id, updated_at = excluded.updated_at`,
  );
  const pullRows = db.prepare(
    'SELECT collection, doc_id, hlc, ciphertext, seq FROM docs WHERE account_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
  );

  const applyPush = db.transaction((accountId: string, deviceId: string, changes: PushChange[]) => {
    let seq = (accountSeq.get(accountId) as { seq: number }).seq;
    let { docs, bytes } = usage.get(accountId) as { docs: number; bytes: number };
    const accepted: (Ref & { seq: number })[] = [];
    const conflicts: (Ref & { seq: number })[] = [];
    const rejected: (Ref & { reason: 'too_large' | 'quota' })[] = [];
    const now = new Date().toISOString();
    for (const c of changes) {
      const ref = { collection: c.collection, id: c.id };
      const size = c.ciphertext.length;
      const existing = getDoc.get(accountId, c.collection, c.id) as DocRow | undefined;
      const currentSeq = existing?.seq ?? 0;
      const nextDocs = docs + (existing ? 0 : 1);
      const nextBytes = bytes - (existing?.size ?? 0) + size;
      if (size > limits.maxCiphertextChars) {
        rejected.push({ ...ref, reason: 'too_large' });
      } else if (c.baseSeq !== currentSeq) {
        conflicts.push({ ...ref, seq: currentSeq });
      } else if (nextDocs > limits.maxDocsPerAccount || nextBytes > limits.maxBytesPerAccount) {
        rejected.push({ ...ref, reason: 'quota' });
      } else {
        seq += 1;
        upsert.run({ account: accountId, collection: c.collection, id: c.id, hlc: c.hlc, ciphertext: c.ciphertext, size, seq, device: deviceId, now });
        docs = nextDocs;
        bytes = nextBytes;
        accepted.push({ ...ref, seq });
      }
    }
    setAccountSeq.run(seq, accountId);
    return { accepted, conflicts, rejected };
  });

  router.post('/push', (req: AuthedRequest, res: Response) => {
    const parsed = parsePush(req.body, limits.maxPushItems);
    if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
    const { accountId, deviceId } = req.auth!;
    res.json(applyPush(accountId, deviceId, parsed));
  });

  router.get('/pull', (req: AuthedRequest, res: Response) => {
    const since = nonNegativeInt(req.query.since ?? '0');
    const limit = nonNegativeInt(req.query.limit ?? '200');
    if (since === null) return res.status(400).json({ error: 'Parâmetro since inválido (inteiro ≥ 0)' });
    if (limit === null || limit < 1 || limit > limits.maxPullLimit) {
      return res.status(400).json({ error: `Parâmetro limit inválido (1 a ${limits.maxPullLimit})` });
    }
    const accountId = req.auth!.accountId;
    const latest = (accountSeq.get(accountId) as { seq: number }).seq;
    const rows = pullRows.all(accountId, since, limit + 1) as PullRow[];
    const changes: { collection: string; id: string; hlc: string; ciphertext: string; seq: number }[] = [];
    let pageBytes = 0;
    for (const r of rows.slice(0, limit)) {
      // Limite de bytes por página: sempre devolve ao menos uma mudança, para o cursor avançar.
      if (changes.length && pageBytes + r.ciphertext.length > limits.maxPullPageBytes) break;
      pageBytes += r.ciphertext.length;
      changes.push({ collection: r.collection, id: r.doc_id, hlc: r.hlc, ciphertext: r.ciphertext, seq: r.seq });
    }
    const hasMore = rows.length > changes.length;
    const cursor = changes.length ? changes[changes.length - 1].seq : since;
    const { epoch } = accountEpoch.get(accountId) as { epoch: string };
    res.json({ changes, cursor, hasMore, latest, epoch });
  });

  router.get('/status', (req: AuthedRequest, res: Response) => {
    const accountId = req.auth!.accountId;
    const { docs, bytes } = usage.get(accountId) as { docs: number; bytes: number };
    const latest = (accountSeq.get(accountId) as { seq: number }).seq;
    const { epoch } = accountEpoch.get(accountId) as { epoch: string };
    res.json({ docs, bytes, latest, epoch, limits });
  });

  return router;
}
