import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

export function openDatabase(path: string): SqliteDatabase {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  migrate(database);
  return database;
}

function migrate(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      source_file_name TEXT NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS article_tasks (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_date TEXT,
      input_title TEXT,
      fetched_title TEXT,
      article_keyword TEXT,
      final_title TEXT,
      final_tags_json TEXT NOT NULL DEFAULT '[]',
      tail_note_template TEXT NOT NULL,
      tail_note TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step TEXT,
      progress REAL NOT NULL DEFAULT 0,
      failure_code TEXT,
      failure_message TEXT,
      output_dir TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES article_tasks(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      step TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_errors (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      row_number INTEGER NOT NULL,
      code TEXT NOT NULL,
      message TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Columns added after the initial schema. SQLite has no ADD COLUMN IF NOT
  // EXISTS, so inspect the table first to keep existing databases migratable.
  const taskColumns = new Set(
    (
      database.prepare("PRAGMA table_info(article_tasks)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  if (!taskColumns.has("manual_content_json")) {
    database.exec(
      "ALTER TABLE article_tasks ADD COLUMN manual_content_json TEXT",
    );
  }
  if (!taskColumns.has("raw_content_path")) {
    database.exec("ALTER TABLE article_tasks ADD COLUMN raw_content_path TEXT");
  }
}
