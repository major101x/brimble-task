import Database from 'better-sqlite3';
import { join } from 'path';

// Open (or create) the SQLite database file at /app/data/deployments.db
// The :: operator tells better-sqlite3 to create the file if it doesn't exist
const db: Database.Database = new Database(join('/app/data', 'deployments.db'));

// Enable WAL mode — Write-Ahead Logging makes SQLite significantly faster
// for concurrent reads while a write is happening. Good habit even for small projects.
db.pragma('journal_mode = WAL');

// Create the deployments table if it doesn't already exist.
// This runs every time the backend starts, but IF NOT EXISTS makes it a no-op
// after the first run — so you never accidentally wipe data on restart.
db.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    image_tag TEXT,
    url TEXT,
    created_at TEXT NOT NULL
  )
`);

export default db;
