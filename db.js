const Database = require('better-sqlite3');

const db = new Database(process.env.DB_FILE || 'auth.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  nome              TEXT    NOT NULL,
  email             TEXT    NOT NULL UNIQUE,
  senha_hash        TEXT    NOT NULL,
  token_version     INTEGER NOT NULL DEFAULT 0,   -- incrementa ao redefinir senha (invalida JWTs antigos)
  tentativas_falhas INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate     INTEGER,                      -- epoch ms
  criado_em         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reset_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,             -- só o hash do token é guardado
  expira_em  INTEGER NOT NULL,
  usado      INTEGER NOT NULL DEFAULT 0
);`);

module.exports = db;
