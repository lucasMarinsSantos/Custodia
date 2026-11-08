// Motor de sincronização de um banco (um "aparelho").
//
// Metadados (no kv do banco SQLCipher, nunca fora dele):
//   sync:doc:<coleção>:<id>  → { s: estado CRDT, q: seq do servidor já fundido }
//   sync:pending             → fila de documentos com mudanças ainda não enviadas
//   sync:cursor              → cursor do pull (maior seq recebido)
//   sync:seen                → maior seq do servidor já visto (pull ou envio aceito)
//   sync:epoch               → identidade do banco do servidor para esta conta (muda se o servidor for recriado)
//   sync:clock               → último HLC emitido (o relógio continua de onde parou)
//
// Ciclo: pull (fusão das mudanças remotas) → push das pendências com baseSeq → se o servidor devolveu conflito
// (alguém enviou antes), novo pull + push. Mudanças remotas são gravadas com { silent: true }: não geram
// onWrite e, portanto, não voltam como eco para o servidor.

import { Collection, USER_COLLECTIONS, VaultDatabase, WriteEvent } from '../../db/Database';
import { decryptSyncDoc, encryptSyncDoc, MAX_SYNC_PLAINTEXT } from '../../crypto/sync';
import { uuid } from '../../crypto';
import { MAX_VERSIONS, normalizeCredential } from '../Repository';
import { Credential, CredentialVersion } from '../../types/models';
import { captureLocal, DocState, HybridClock, isHlc, materialize, mergeStates, parseState, scrubDead, stableStringify, stateClock, stateClocks } from './crdt';
import { PullResponse, PushChange, RemoteChange, SyncTransport } from './http';

const P_DOC = 'sync:doc:';
const K_PENDING = 'sync:pending';
const K_CURSOR = 'sync:cursor';
const K_SEEN = 'sync:seen';
const K_EPOCH = 'sync:epoch';
const K_CLOCK = 'sync:clock';
export const SYNC_KV_PREFIX = 'sync:';

/** Ids aceitos (UUID e afins): o mesmo formato que o servidor valida. */
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const PULL_PAGE = 200;
export const PUSH_BATCH = 100;
/** Bytes por envio (o servidor aceita bem mais; lotes menores falham menos em rede ruim). */
export const PUSH_BATCH_CHARS = 3 * 1024 * 1024;
/** Igual ao limite padrão do servidor para um documento cifrado. */
export const MAX_DOC_CIPHERTEXT = 1024 * 1024;
const MAX_ROUNDS = 4;

export const SYNCED_COLLECTIONS: Collection[] = USER_COLLECTIONS;

interface Meta {
  s: DocState;
  q: number;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  applied: number;
  conflicts: number;
  rejected: number;
  invalid: number;
  /** Aviso para a tela (ex.: cota do servidor atingida), sem impedir o restante. */
  warning: string | null;
}

const emptyResult = (): SyncResult => ({ pushed: 0, pulled: 0, applied: 0, conflicts: 0, rejected: 0, invalid: 0, warning: null });

const FIELD_LABELS: Record<string, string> = {
  title: 'título',
  username: 'usuário',
  password: 'senha',
  url: 'URL',
  notes: 'notas',
  category: 'categoria',
  folderId: 'pasta',
  favorite: 'favorito',
  customFields: 'campos personalizados',
  icon: 'ícone',
};

function describeSyncChange(prev: Record<string, unknown> | null, next: Record<string, unknown>): string {
  if (!prev) return 'Recebida de outro aparelho';
  const labels = Object.keys(FIELD_LABELS).filter(k => stableStringify(prev[k]) !== stableStringify(next[k]));
  return labels.length ? `Sincronizado de outro aparelho: ${labels.map(k => FIELD_LABELS[k]).join(', ')}` : 'Sincronizado de outro aparelho';
}

const keyOf = (collection: string, id: string) => `${collection}:${id}`;

/** Ciclos na árvore de pastas (cada ciclo como a lista dos ids que o formam). */
export function findCycles(byId: Map<string, { id: string; parentId?: string | null }>): string[][] {
  const done = new Set<string>();
  const cycles: string[][] = [];
  for (const start of byId.keys()) {
    const path: string[] = [];
    let cur: string | null | undefined = start;
    while (cur && byId.has(cur) && !done.has(cur) && !path.includes(cur)) {
      path.push(cur);
      cur = byId.get(cur)!.parentId;
    }
    if (cur && path.includes(cur)) cycles.push(path.slice(path.indexOf(cur)));
    path.forEach(id => done.add(id));
  }
  return cycles;
}

export class SyncEngine {
  private tail: Promise<unknown> = Promise.resolve();
  private running: Promise<SyncResult> | null = null;
  private versionSeq = 0;

  constructor(
    private readonly db: VaultDatabase,
    private readonly transport: SyncTransport,
    private readonly key: Uint8Array,
    readonly clock: HybridClock,
    private readonly collections: Collection[] = SYNCED_COLLECTIONS,
  ) {}

  /** Exclusão mútua: escritas locais e aplicação de mudanças remotas não se intercalam. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  /** Recupera o relógio salvo (o HLC nunca anda para trás entre sessões). */
  async init(): Promise<void> {
    const saved = await this.db.getKv(K_CLOCK);
    if (saved && isHlc(saved)) this.clock.observe(saved);
  }

  // ---------------------------------------------------------------------------
  // Metadados
  // ---------------------------------------------------------------------------
  private async meta(collection: string, id: string): Promise<Meta | null> {
    const raw = await this.db.getKv(P_DOC + keyOf(collection, id));
    if (!raw) return null;
    try {
      const j = JSON.parse(raw);
      const s = parseState(j?.s);
      return s ? { s: scrubDead(s), q: Number.isSafeInteger(j.q) ? j.q : 0 } : null;
    } catch {
      return null;
    }
  }

  private async saveMeta(collection: string, id: string, m: Meta): Promise<void> {
    await this.db.setKv(P_DOC + keyOf(collection, id), JSON.stringify({ ...m, s: scrubDead(m.s) }));
  }

  async pending(): Promise<string[]> {
    const raw = await this.db.getKv(K_PENDING);
    try {
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(k => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }

  private async setPending(list: Iterable<string>): Promise<void> {
    await this.db.setKv(K_PENDING, JSON.stringify([...new Set(list)]));
  }

  private async addPending(key: string): Promise<void> {
    const list = await this.pending();
    if (!list.includes(key)) await this.setPending([...list, key]);
  }

  private async removePending(keys: string[]): Promise<void> {
    if (!keys.length) return;
    const drop = new Set(keys);
    await this.setPending((await this.pending()).filter(k => !drop.has(k)));
  }

  async cursor(): Promise<number> {
    const n = Number(await this.db.getKv(K_CURSOR));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  private async saveClock(): Promise<void> {
    await this.db.setKv(K_CLOCK, this.clock.last());
  }

  private synced(collection: string, id: string): collection is Collection {
    return (this.collections as string[]).includes(collection) && DOC_ID_RE.test(id);
  }

  // ---------------------------------------------------------------------------
  // Mudanças locais
  // ---------------------------------------------------------------------------
  /** Registra uma escrita local (chamado por vaultDb.onWrite). */
  recordWrite(e: WriteEvent): Promise<boolean> {
    if (!this.synced(e.collection, e.id)) return Promise.resolve(false);
    return this.locked(async () => {
      const doc = e.deleted ? null : ((e.data as Record<string, unknown>) ?? (await this.db.get(e.collection, e.id)));
      return this.capture(e.collection, e.id, doc);
    });
  }

  private async capture(collection: Collection, id: string, doc: Record<string, unknown> | null): Promise<boolean> {
    const meta = await this.meta(collection, id);
    const { state, changed } = captureLocal(meta?.s ?? null, doc, this.clock);
    if (!changed || !state) return false;
    await this.saveMeta(collection, id, { s: state, q: meta?.q ?? 0 });
    await this.addPending(keyOf(collection, id));
    await this.saveClock();
    return true;
  }

  /**
   * Compara todo o banco com os metadados: pega escritas silenciosas, documentos criados antes de ativar a
   * sincronização e exclusões feitas com ela desligada. Devolve quantos documentos ficaram pendentes.
   */
  reconcile(): Promise<number> {
    return this.locked(async () => {
      let n = 0;
      for (const col of this.collections) {
        const docs = await this.db.all<Record<string, unknown> & { id: string }>(col);
        const present = new Set<string>();
        for (const d of docs) {
          if (!DOC_ID_RE.test(String(d.id))) continue;
          present.add(d.id);
          if (await this.capture(col, d.id, d)) n++;
        }
        for (const k of await this.db.kvKeys(`${P_DOC}${col}:`)) {
          const id = k.slice(P_DOC.length + col.length + 1);
          if (!present.has(id) && (await this.capture(col, id, null))) n++;
        }
      }
      return n;
    });
  }

  // ---------------------------------------------------------------------------
  // Sincronização
  // ---------------------------------------------------------------------------
  /** Uma sincronização por vez: chamadas simultâneas recebem o mesmo resultado. */
  sync(): Promise<SyncResult> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(): Promise<SyncResult> {
    const result = emptyResult();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await this.pullAll(result);
      if (result.applied) await this.locked(() => this.repairFolders());
      const conflicts = await this.pushPending(result);
      if (!conflicts) break;
    }
    await this.saveClock();
    return result;
  }

  // ---------------------------------------------------------------------------
  // Invariantes entre documentos (o CRDT funde cada documento isoladamente)
  // ---------------------------------------------------------------------------
  /** A pasta foi excluída (lápide conhecida)? Pasta só ainda não recebida não conta. */
  private async folderDeleted(id: string): Promise<boolean> {
    const m = await this.meta('folders', id);
    return !!m && materialize(m.s, id) === null;
  }

  /**
   * Mover pastas em aparelhos diferentes ao mesmo tempo pode criar um ciclo (A dentro de B e B dentro de A), e
   * excluir uma pasta enquanto outro aparelho põe algo nela deixa referências soltas. Depois de cada pull a
   * regra é a mesma em todos os aparelhos (determinística): no ciclo, a pasta de menor id volta para a raiz;
   * referência a pasta excluída vira "sem pasta". A correção é uma escrita local, enviada como qualquer outra.
   */
  private async repairFolders(): Promise<void> {
    if (!this.collections.includes('folders')) return;
    const folders = await this.db.all<{ id: string; parentId?: string | null }>('folders');
    const byId = new Map(folders.map(f => [f.id, f]));
    const toRoot = new Set<string>();
    for (const f of folders) {
      if (f.parentId && !byId.has(f.parentId) && (await this.folderDeleted(f.parentId))) toRoot.add(f.id);
    }
    for (const cycle of findCycles(byId)) toRoot.add(cycle.sort()[0]);
    for (const id of toRoot) await this.fixRef('folders', { ...byId.get(id)!, parentId: null });
    for (const col of ['credentials', 'notes'] as Collection[]) {
      if (this.collections.includes(col)) await this.repairFolderRefs(col, byId);
    }
  }

  private async repairFolderRefs(col: Collection, folders: Map<string, unknown>): Promise<void> {
    for (const d of await this.db.all<{ id: string; folderId?: string | null }>(col)) {
      if (d.folderId && !folders.has(d.folderId) && (await this.folderDeleted(d.folderId))) await this.fixRef(col, { ...d, folderId: null });
    }
  }

  private async fixRef(col: Collection, doc: { id: string; [k: string]: unknown }): Promise<void> {
    await this.db.put(col, doc, { silent: true });
    await this.capture(col, doc.id, doc as Record<string, unknown>);
  }

  private async seen(): Promise<number> {
    const n = Number(await this.db.getKv(K_SEEN));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  private async markSeen(seq: number): Promise<void> {
    if (seq > (await this.seen())) await this.db.setKv(K_SEEN, String(seq));
  }

  /**
   * O servidor perdeu o que já tínhamos visto (banco apagado, restaurado de um backup antigo ou trocado):
   * o contador dele está atrás do nosso ou a identidade (epoch) mudou.
   */
  private async serverWasReset(page: PullResponse): Promise<boolean> {
    const epoch = await this.db.getKv(K_EPOCH);
    if (page.epoch && epoch && page.epoch !== epoch) return true;
    return page.latest < Math.max(await this.cursor(), await this.seen());
  }

  private async pullAll(result: SyncResult): Promise<void> {
    let cursor = await this.cursor();
    let resets = 0;
    for (;;) {
      const page = await this.transport.pull(cursor, PULL_PAGE);
      if (resets === 0 && (await this.serverWasReset(page))) {
        // Reenvia tudo e busca desde o início (a fusão descarta o que já tínhamos).
        resets++;
        await this.resetServerState(page.epoch);
        cursor = 0;
        continue;
      }
      await this.locked(async () => {
        for (const change of page.changes) await this.applyRemote(change, result);
        await this.db.setKv(K_CURSOR, String(page.cursor));
        await this.markSeen(page.cursor);
        if (page.epoch) await this.db.setKv(K_EPOCH, page.epoch);
      });
      cursor = page.cursor;
      if (!page.hasMore || !page.changes.length) return;
    }
  }

  private async resetServerState(epoch?: string): Promise<void> {
    await this.locked(async () => {
      const keys: string[] = [];
      for (const k of await this.db.kvKeys(P_DOC)) {
        const [col, ...rest] = k.slice(P_DOC.length).split(':');
        const id = rest.join(':');
        const m = await this.meta(col, id);
        if (!m) continue;
        await this.saveMeta(col, id, { s: m.s, q: 0 });
        keys.push(keyOf(col, id));
      }
      await this.setPending(keys);
      await this.db.setKv(K_CURSOR, '0');
      await this.db.setKv(K_SEEN, '0');
      if (epoch) await this.db.setKv(K_EPOCH, epoch);
    });
  }

  /** Decifra, valida e funde uma mudança remota com o estado local. */
  private async applyRemote(change: RemoteChange, result: SyncResult): Promise<void> {
    if (!this.synced(change.collection, change.id)) {
      result.invalid++;
      return;
    }
    const col = change.collection as Collection;
    const meta = await this.meta(col, change.id);
    if (meta && meta.q >= change.seq) return; // já fundida (inclusive o nosso próprio envio)
    const remote = this.decrypt(col, change);
    if (!remote) {
      // Bloco adulterado, de outro documento ou ilegível: ignorado. O próximo envio local o substitui.
      result.invalid++;
      if (meta) await this.saveMeta(col, change.id, { s: meta.s, q: change.seq });
      return;
    }
    result.pulled++;
    stateClocks(remote).forEach(t => this.clock.observe(t));

    const before = await this.db.get<Record<string, unknown>>(col, change.id);
    // Escritas silenciosas locais (ex.: data do último uso) entram no estado antes da fusão.
    const local = captureLocal(meta?.s ?? null, before, this.clock).state;
    const merged = mergeStates(local, remote)!;
    const after = materialize(merged, change.id);
    // As versões que perderam a fusão vão para o histórico antes da versão vencedora (ordem cronológica).
    if (col === 'credentials') await this.recordLosingVersions(change.id, before, local, remote, merged);
    if (stableStringify(before) !== stableStringify(after)) {
      await this.applyDoc(col, change.id, before, after);
      result.applied++;
    }
    await this.saveMeta(col, change.id, { s: merged, q: change.seq });
    const key = keyOf(col, change.id);
    // Se o estado local tem algo que o servidor não tem, continua pendente; senão sai da fila.
    if (stableStringify(merged) === stableStringify(remote)) await this.removePending([key]);
    else await this.addPending(key);
  }

  private decrypt(col: Collection, change: RemoteChange): DocState | null {
    try {
      const text = decryptSyncDoc(this.key, col, change.id, change.ciphertext);
      if (text.length > MAX_SYNC_PLAINTEXT) return null;
      return parseState(JSON.parse(text));
    } catch {
      return null;
    }
  }

  private async applyDoc(col: Collection, id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
    if (!after) {
      await this.db.remove(col, id, { silent: true });
      // Mesmo comportamento da exclusão local: o histórico da credencial vai junto.
      if (col === 'credentials') {
        for (const v of await this.versionsOf(id)) await this.db.remove('versions', v.id, { silent: true });
      }
      return;
    }
    await this.db.put(col, after as { id: string }, { silent: true });
    if (col === 'credentials') await this.addVersion(id, describeSyncChange(before, after), after);
  }

  /**
   * Conflito (cenário BDD "Conflito de sincronização (offline)"): vale a edição mais recente de cada campo e a
   * versão que perdeu vai para o histórico desta credencial, para consulta ou restauração. Vale nos dois sentidos:
   *  • um campo vindo do outro aparelho perdeu para uma edição local mais recente → guarda a versão do outro;
   *  • um campo deste aparelho perdeu para uma edição remota mais recente → guarda a versão local (se o histórico
   *    ainda não a tiver, o que acontece quando a edição veio do Repository, que já registra cada salvamento).
   */
  private async recordLosingVersions(id: string, before: Record<string, unknown> | null, local: DocState | null, remote: DocState, merged: DocState) {
    const lost = (side: DocState | null) =>
      !!side && Object.entries(side.fields).some(([k, f]) => merged.fields[k].t !== f.t && stableStringify(merged.fields[k].v) !== stableStringify(f.v));
    if (before && lost(local) && !(await this.latestVersionIs(id, before))) {
      await this.addVersion(id, 'Versão deste aparelho (substituída por uma edição mais recente de outro aparelho)', before);
    }
    const remoteDoc = materialize(remote, id);
    if (remoteDoc && lost(remote)) await this.addVersion(id, 'Versão de outro aparelho (substituída pela edição mais recente)', remoteDoc);
  }

  private async latestVersionIs(credentialId: string, doc: Record<string, unknown>): Promise<boolean> {
    const latest = (await this.versionsOf(credentialId)).sort((a, b) => b.changedAt.localeCompare(a.changedAt) || (b.seq || 0) - (a.seq || 0))[0];
    return !!latest && stableStringify(normalizeCredential(latest.snapshot)) === stableStringify(normalizeCredential(doc as unknown as Credential));
  }

  private async versionsOf(credentialId: string): Promise<CredentialVersion[]> {
    return (await this.db.all<CredentialVersion>('versions')).filter(v => v.credentialId === credentialId);
  }

  private async addVersion(credentialId: string, summary: string, doc: Record<string, unknown>) {
    this.versionSeq = Math.max(this.versionSeq + 1, Date.now() * 1000);
    const version: CredentialVersion = {
      id: uuid(),
      credentialId,
      changeType: 'sync',
      changedAt: new Date().toISOString(),
      seq: this.versionSeq,
      summary,
      snapshot: normalizeCredential(doc as unknown as Credential),
    };
    await this.db.put('versions', version, { silent: true });
    const all = (await this.versionsOf(credentialId)).sort((a, b) => b.changedAt.localeCompare(a.changedAt) || (b.seq || 0) - (a.seq || 0));
    for (const old of all.slice(MAX_VERSIONS)) await this.db.remove('versions', old.id, { silent: true });
  }

  /** Envia as pendências. Devolve o número de conflitos (documentos que mudaram no servidor desde o último pull). */
  private async pushPending(result: SyncResult): Promise<number> {
    const { batches, sent } = await this.locked(() => this.buildBatches(result));
    let conflicts = 0;
    for (const batch of batches) {
      const res = await this.transport.push(batch);
      await this.locked(async () => {
        const done: string[] = [];
        for (const a of res.accepted) {
          const key = keyOf(a.collection, a.id);
          const m = await this.meta(a.collection, a.id);
          if (!m || !sent.has(key)) continue;
          await this.saveMeta(a.collection, a.id, { s: m.s, q: a.seq });
          await this.markSeen(a.seq);
          // Só sai da fila se não houve edição local durante o envio.
          if (stableStringify(m.s) === sent.get(key)) done.push(key);
          result.pushed++;
        }
        for (const r of res.rejected) {
          result.rejected++;
          if (r.reason === 'too_large') done.push(keyOf(r.collection, r.id));
          result.warning =
            r.reason === 'quota' ? 'O limite de documentos ou de espaço da conta no servidor foi atingido.' : 'Um item é grande demais para sincronizar e ficou só neste aparelho.';
        }
        await this.removePending(done);
      });
      conflicts += res.conflicts.length;
    }
    result.conflicts += conflicts;
    return conflicts;
  }

  private async buildBatches(result: SyncResult): Promise<{ batches: PushChange[][]; sent: Map<string, string> }> {
    const batches: PushChange[][] = [];
    const sent = new Map<string, string>();
    const drop: string[] = [];
    let batch: PushChange[] = [];
    let chars = 0;
    for (const key of await this.pending()) {
      const [col, ...rest] = key.split(':');
      const id = rest.join(':');
      const m = this.synced(col, id) ? await this.meta(col, id) : null;
      if (!m) {
        drop.push(key);
        continue;
      }
      const ciphertext = encryptSyncDoc(this.key, col, id, JSON.stringify(m.s));
      if (ciphertext.length > MAX_DOC_CIPHERTEXT) {
        drop.push(key);
        result.rejected++;
        result.warning = 'Um item é grande demais para sincronizar e ficou só neste aparelho.';
        continue;
      }
      if (batch.length >= PUSH_BATCH || (batch.length && chars + ciphertext.length > PUSH_BATCH_CHARS)) {
        batches.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push({ collection: col, id, hlc: stateClock(m.s), ciphertext, baseSeq: m.q });
      chars += ciphertext.length;
      sent.set(key, stableStringify(m.s));
    }
    if (batch.length) batches.push(batch);
    await this.removePending(drop);
    return { batches, sent };
  }

  /** Apaga todos os metadados de sincronização do banco (ao desconectar). */
  async clear(): Promise<void> {
    await this.locked(() => this.db.removeKvPrefix(SYNC_KV_PREFIX));
  }
}
