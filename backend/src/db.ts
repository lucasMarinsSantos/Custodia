// Banco do servidor (SQLite via better-sqlite3).
// Guarda só dados opacos: o hash do segredo de autenticação, os aparelhos e os blocos cifrados.
// O servidor não tem a chave de sincronização e não interpreta o conteúdo dos documentos.
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

export type { DB };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    auth_hash TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    -- Identidade aleatória da conta neste banco: se o servidor for recriado, o aparelho percebe e reenvia tudo.
    epoch TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY (account_id, id)
  );

  -- Último estado cifrado de cada documento. "seq" é o contador por conta (cursor do pull e
  -- versão para o controle de concorrência otimista do push).
  CREATE TABLE IF NOT EXISTS docs (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    collection TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    hlc TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    size INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, collection, doc_id)
  );
  CREATE INDEX IF NOT EXISTS idx_docs_account_seq ON docs(account_id, seq);
`;

/** Abre (ou cria) o banco e aplica o esquema. Use ':memory:' nos testes. */
export function openDatabase(file: string): DB {
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Bancos criados antes do epoch ganham a coluna com um valor aleatório por conta. */
function migrate(db: DB) {
  const cols = db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[];
  if (!cols.some(c => c.name === 'epoch')) {
    db.exec("ALTER TABLE accounts ADD COLUMN epoch TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE accounts SET epoch = lower(hex(randomblob(16))) WHERE epoch = ''");
  }
}
