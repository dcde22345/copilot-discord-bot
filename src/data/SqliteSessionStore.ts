import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { SessionRecord } from "../models/SessionRecord.js";
import type { SessionConfigState } from "../models/SessionConfigState.js";
import type { ConversationUnit } from "../models/ConversationUnit.js";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  thread_id     TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL,
  parent_channel_id TEXT NOT NULL,
  copilot_session_id TEXT NOT NULL,
  repo_path     TEXT,
  config_json   TEXT NOT NULL DEFAULT '{}',
  created_utc   TEXT NOT NULL,
  updated_utc   TEXT NOT NULL
)`;

const CREATE_CONVERSATION_UNITS_SQL = `
CREATE TABLE IF NOT EXISTS conversation_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  user_question TEXT NOT NULL,
  assistant_answer TEXT NOT NULL,
  created_utc TEXT NOT NULL,
  embedding BLOB,
  FOREIGN KEY(thread_id) REFERENCES sessions(thread_id) ON DELETE CASCADE
)`;

const CREATE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_conversation_thread_id ON conversation_units(thread_id);
CREATE INDEX IF NOT EXISTS idx_conversation_created_utc ON conversation_units(created_utc DESC)`;

const CREATE_VEC_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_vectors USING vec0(
  embedding float[1536]
)`;

interface SessionRow {
  thread_id: string;
  guild_id: string;
  parent_channel_id: string;
  copilot_session_id: string;
  repo_path: string | null;
  config_json: string;
  created_utc: string;
  updated_utc: string;
}

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    threadId: BigInt(row.thread_id),
    guildId: BigInt(row.guild_id),
    parentChannelId: BigInt(row.parent_channel_id),
    copilotSessionId: row.copilot_session_id,
    repoPath: row.repo_path,
    configJson: row.config_json,
    createdUtc: new Date(row.created_utc),
    updatedUtc: new Date(row.updated_utc),
  };
}

export class SqliteSessionStore {
  db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "sessions.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(CREATE_TABLE_SQL);
    this.db.exec(CREATE_CONVERSATION_UNITS_SQL);
    this.db.exec(CREATE_INDEXES_SQL);
    this.db.exec(CREATE_VEC_TABLE_SQL);
  }

  getByThreadId(threadId: bigint): SessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE thread_id = ?")
      .get(threadId.toString()) as SessionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  upsert(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (thread_id, guild_id, parent_channel_id, copilot_session_id, repo_path, config_json, created_utc, updated_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           repo_path = excluded.repo_path,
           config_json = excluded.config_json,
           updated_utc = excluded.updated_utc`
      )
      .run(
        record.threadId.toString(),
        record.guildId.toString(),
        record.parentChannelId.toString(),
        record.copilotSessionId,
        record.repoPath,
        record.configJson,
        record.createdUtc.toISOString(),
        record.updatedUtc.toISOString()
      );
  }

  list(): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY created_utc DESC")
      .all() as SessionRow[];
    return rows.map(rowToRecord);
  }

  readConfig(record: SessionRecord): SessionConfigState {
    try {
      return JSON.parse(record.configJson) as SessionConfigState;
    } catch {
      return {};
    }
  }

  writeConfig(cfg: SessionConfigState): string {
    return JSON.stringify(cfg, null, 2);
  }

  saveConversationUnit(threadId: string, userQuestion: string, assistantAnswer: string, embeddingBuffer: Buffer | null): number {
    const now = new Date().toISOString();
    const insertStmt = this.db.prepare(
      `INSERT INTO conversation_units (thread_id, user_question, assistant_answer, created_utc, embedding)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = insertStmt.run(threadId, userQuestion, assistantAnswer, now, embeddingBuffer);
    const rowid = result.lastInsertRowid as number;

    if (embeddingBuffer !== null) {
      const vecInsertStmt = this.db.prepare(
        `INSERT INTO conversation_vectors (rowid, embedding)
         VALUES (?, ?)`
      );
      vecInsertStmt.run(rowid, embeddingBuffer);
    }

    return rowid;
  }

  searchTopKConversations(queryEmbedding: Float32Array, k: number): ConversationUnit[] {
    const sql = `
      SELECT
        cu.id,
        cu.thread_id,
        cu.user_question,
        cu.assistant_answer,
        cu.created_utc,
        cv.distance
      FROM conversation_vectors cv
      JOIN conversation_units cu ON cv.rowid = cu.id
      WHERE cv.embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(new Uint8Array(queryEmbedding.buffer), k) as Array<{
      id: number;
      thread_id: string;
      user_question: string;
      assistant_answer: string;
      created_utc: string;
      distance: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      threadId: row.thread_id,
      userQuestion: row.user_question,
      assistantAnswer: row.assistant_answer,
      createdUtc: new Date(row.created_utc),
      distance: row.distance,
    }));
  }

  close(): void {
    this.db.close();
  }
}
