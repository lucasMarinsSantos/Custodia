// Banco local criptografado (SQLCipher via @op-engineering/op-sqlite)
// O arquivo do banco é cifrado (AES-256) com a chave do cofre (DEK), que só existe em memória
// enquanto o cofre está desbloqueado.

import { open, type DB } from '@op-engineering/op-sqlite';
import { sha256Hex } from '../crypto';

export type Collection = 'credentials' | 'folders' | 'versions' | 'logos';

export interface WriteEvent {
  collection: Collection;
  id: string;
  deleted: boolean;
  data?: any;
}

type WriteListener = (e: WriteEvent) => void;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS docs (
     collection TEXT NOT NULL,
     id TEXT NOT NULL,
     data TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (collection, id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_docs_collection ON docs(collection)',
  `CREATE TABLE IF NOT EXISTS kv (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

export class VaultDatabase {
  private db: DB | null = null;
  private listeners = new Set<WriteListener>();
  private anyListeners = new Set<() => void>();
  private cache = new Map<Collection, Map<string, any>>();
  profileId: string | null = null;

  get isOpen(): boolean {
    return this.db !== null;
  }

  static fileName(profileId: string): string {
    return `custodia_${profileId}.sqlite`;
  }

  async open(profileId: string, keyHex: string): Promise<void> {
    if (this.db) this.close();
    const db = open({ name: VaultDatabase.fileName(profileId), encryptionKey: keyHex });
    try {
      // Falha aqui se a chave estiver errada (SQLCipher retorna "file is not a database")
      await db.execute('SELECT count(*) AS n FROM sqlite_master');
      await db.execute('PRAGMA journal_mode = DELETE');
      await db.execute('PRAGMA foreign_keys = ON');
      for (const stmt of SCHEMA) await db.execute(stmt);
    } catch (e) {
      try {
        db.close();
      } catch {
        // ignora
      }
      throw e;
    }
    this.db = db;
    this.profileId = profileId;
    this.cache.clear();
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignora
      }
    }
    this.db = null;
    this.profileId = null;
    this.cache.clear();
  }

  getPath(): string | null {
    try {
      return this.db ? this.db.getDbPath() : null;
    } catch {
      return null;
    }
  }

  private req(): DB {
    if (!this.db) throw new Error('Cofre bloqueado');
    return this.db;
  }

  onWrite(listener: WriteListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notificado em qualquer escrita (inclusive silenciosas). Usado pela verificação de integridade. */
  onAnyWrite(listener: () => void): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  private touched() {
    this.anyListeners.forEach(l => {
      try {
        l();
      } catch {
        // ignora
      }
    });
  }

  private emit(e: WriteEvent) {
    this.listeners.forEach(l => {
      try {
        l(e);
      } catch {
        // ignora
      }
    });
  }

  async integrityCheck(): Promise<string> {
    const res = await this.req().execute('PRAGMA integrity_check');
    const row = res.rows[0] as any;
    return row ? String(Object.values(row)[0]) : 'unknown';
  }

  // -------------------------------------------------------------------------
  // Documentos
  // -------------------------------------------------------------------------
  private async loadCollection(collection: Collection): Promise<Map<string, any>> {
    const cached = this.cache.get(collection);
    if (cached) return cached;
    const res = await this.req().execute('SELECT id, data FROM docs WHERE collection = ?', [collection]);
    const map = new Map<string, any>();
    for (const row of res.rows as any[]) {
      try {
        map.set(String(row.id), JSON.parse(String(row.data)));
      } catch {
        // documento corrompido é ignorado (detectado pela verificação de integridade)
      }
    }
    this.cache.set(collection, map);
    return map;
  }

  async all<T>(collection: Collection): Promise<T[]> {
    const map = await this.loadCollection(collection);
    return [...map.values()].map(v => JSON.parse(JSON.stringify(v)));
  }

  async get<T>(collection: Collection, id: string): Promise<T | null> {
    const map = await this.loadCollection(collection);
    const v = map.get(id);
    return v ? JSON.parse(JSON.stringify(v)) : null;
  }

  async put<T extends { id: string }>(collection: Collection, doc: T, opts: { silent?: boolean } = {}): Promise<void> {
    const data = JSON.stringify(doc);
    const now = new Date().toISOString();
    await this.req().execute(
      'INSERT INTO docs (collection, id, data, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      [collection, doc.id, data, now],
    );
    const map = await this.loadCollection(collection);
    map.set(doc.id, JSON.parse(data));
    this.touched();
    if (!opts.silent) this.emit({ collection, id: doc.id, deleted: false, data: doc });
  }

  async remove(collection: Collection, id: string, opts: { silent?: boolean } = {}): Promise<void> {
    await this.req().execute('DELETE FROM docs WHERE collection = ? AND id = ?', [collection, id]);
    const map = await this.loadCollection(collection);
    map.delete(id);
    this.touched();
    if (!opts.silent) this.emit({ collection, id, deleted: true });
  }

  async clearCollection(collection: Collection): Promise<void> {
    const docs = await this.all<{ id: string }>(collection);
    for (const d of docs) await this.remove(collection, d.id, { silent: true });
  }

  // -------------------------------------------------------------------------
  // KV
  // -------------------------------------------------------------------------
  async getKv(key: string): Promise<string | null> {
    const res = await this.req().execute('SELECT value FROM kv WHERE key = ?', [key]);
    const row = res.rows[0] as any;
    return row ? String(row.value) : null;
  }

  async setKv(key: string, value: string): Promise<void> {
    await this.req().execute(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }

  // -------------------------------------------------------------------------
  // Integridade: digest de todo o conteúdo do banco
  // -------------------------------------------------------------------------
  async contentDigest(): Promise<string> {
    const res = await this.req().execute('SELECT collection, id, data FROM docs ORDER BY collection, id');
    let acc = '';
    for (const row of res.rows as any[]) {
      acc = sha256Hex(acc + '|' + row.collection + '|' + row.id + '|' + sha256Hex(String(row.data)));
    }
    return sha256Hex(acc);
  }
}

export const vaultDb = new VaultDatabase();
