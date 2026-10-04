// Mock de @op-engineering/op-sqlite para testes: usa better-sqlite3 em memória.
// (No dispositivo o banco real é SQLCipher; aqui a cifragem não é simulada.)
const Database = require('better-sqlite3');
const dbs = new Map();

function open({ name, encryptionKey }) {
  let entry = dbs.get(name);
  if (!entry) {
    entry = { db: new Database(':memory:'), key: encryptionKey };
    dbs.set(name, entry);
  }
  if (entry.key !== encryptionKey) {
    return {
      execute: async () => {
        throw new Error('file is not a database');
      },
      close() {},
      delete() {},
      getDbPath: () => name,
    };
  }
  const run = (sql, params = []) => {
    const stmt = entry.db.prepare(sql);
    if (stmt.reader) return { rows: stmt.all(...params), rowsAffected: 0 };
    const info = stmt.run(...params);
    return { rows: [], rowsAffected: info.changes, insertId: Number(info.lastInsertRowid) };
  };
  return {
    execute: async (sql, params) => run(sql, params),
    executeSync: (sql, params) => run(sql, params),
    close() {},
    delete() {
      dbs.delete(name);
    },
    getDbPath: () => name,
  };
}

module.exports = { open, __dbs: dbs };
