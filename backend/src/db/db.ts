import path from "node:path";
import Database from "better-sqlite3";
import { env } from "../config/env.js";
import { ensureDir, toAbsolutePath } from "../utils/fileUtils.js";

const absoluteDbPath = toAbsolutePath(env.dbPath);
ensureDir(path.dirname(absoluteDbPath));

const db = new Database(absoluteDbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER DEFAULT 0,
    raw_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS memoirs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id INTEGER,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    time TEXT,
    location TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (recording_id) REFERENCES recordings(id)
  );
`);

// 이미 생성된 테이블에 컬럼이 없을 경우를 대비한 자동 마이그레이션 (에러 원천 차단)
try {
  db.exec("ALTER TABLE memoirs ADD COLUMN time TEXT;");
} catch (_) {
  // 이미 컬럼이 존재하면 에러 무시
}
try {
  db.exec("ALTER TABLE memoirs ADD COLUMN location TEXT;");
} catch (_) {
  // 이미 컬럼이 존재하면 에러 무시
}

export default db;