import { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";

/** Shared tables. Bot tables all start with `pibot_<32 hex>_`, so these can never collide. */
export const BOTS_TABLE = "pibot_bots";
export const THREADS_TABLE = "pibot_threads";

export type BotRecord = {
  readonly id: string;
  readonly name: string;
  /** Table prefix of this bot's Pi Durable session, `pibot_<id without dashes>_`. */
  readonly prefix: string;
  readonly createdAt: string;
};

export type ThreadRecord = {
  readonly botId: string;
  readonly conversationId: number;
  readonly parentConversationId: number;
  /** Entry the thread was forked at; the thread inherits context up to and including it. */
  readonly forkedAt: number;
  /**
   * Generated from the thread's first message (`[models.titles]`); "" until then. Metadata only:
   * thread listing and search use it, the UI never shows it, and nothing renames a thread.
   */
  readonly title: string;
  readonly createdAt: string;
};

type BotRow = { id: string; name: string; schema_prefix: string; created_at: string };
type ThreadRow = {
  bot_id: string;
  conversation_id: number;
  parent_conversation_id: number;
  forked_at_entry: number;
  title: string;
  created_at: string;
};

const BOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Per-bot table prefix, mirroring Woven's `wm_pi_<id>_`. */
export function botPrefix(botId: string): string {
  if (!BOT_ID.test(botId)) throw new Error(`invalid bot id ${JSON.stringify(botId)}`);
  const prefix = `pibot_${botId.replaceAll("-", "")}_`;
  validateSqliteSchemaPrefix(prefix);
  return prefix;
}

function toBot(row: BotRow): BotRecord {
  return { id: row.id, name: row.name, prefix: row.schema_prefix, createdAt: row.created_at };
}

function toThread(row: ThreadRow): ThreadRecord {
  return {
    botId: row.bot_id,
    conversationId: row.conversation_id,
    parentConversationId: row.parent_conversation_id,
    forkedAt: row.forked_at_entry,
    title: row.title,
    createdAt: row.created_at,
  };
}

/** Names of every schema object owned by one prefix. */
export async function prefixedObjects(
  db: SqliteExecutor,
  prefix: string,
): Promise<{ type: string; name: string }[]> {
  return db.all<{ type: string; name: string }>(
    "SELECT type, name FROM sqlite_master WHERE substr(name, 1, ?) = ? AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    prefix.length,
    prefix,
  );
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The bots registry plus thread metadata, in the shared database. */
export class BotRegistry {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  async migrate(): Promise<void> {
    await this.#db.exec(`
      CREATE TABLE IF NOT EXISTS ${BOTS_TABLE} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schema_prefix TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ${THREADS_TABLE} (
        bot_id TEXT NOT NULL REFERENCES ${BOTS_TABLE}(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL,
        parent_conversation_id INTEGER NOT NULL,
        forked_at_entry INTEGER NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, conversation_id)
      ) STRICT;
    `);
  }

  async list(): Promise<BotRecord[]> {
    const rows = await this.#db.all<BotRow>(
      `SELECT id, name, schema_prefix, created_at FROM ${BOTS_TABLE} ORDER BY created_at, id`,
    );
    return rows.map(toBot);
  }

  async get(id: string): Promise<BotRecord | undefined> {
    const row = await this.#db.get<BotRow>(
      `SELECT id, name, schema_prefix, created_at FROM ${BOTS_TABLE} WHERE id = ?`,
      id,
    );
    return row ? toBot(row) : undefined;
  }

  async insert(record: BotRecord): Promise<void> {
    await this.#db.run(
      `INSERT INTO ${BOTS_TABLE} (id, name, schema_prefix, created_at) VALUES (?, ?, ?, ?)`,
      record.id,
      record.name,
      record.prefix,
      record.createdAt,
    );
  }

  /** Drop every table, view and trigger under the bot's prefix, then its registry row. */
  async remove(id: string): Promise<boolean> {
    const record = await this.get(id);
    if (!record) return false;
    await this.#db.transaction(async (tx) => {
      // Durable tables reference each other; check foreign keys at commit, when all are gone.
      await tx.exec("PRAGMA defer_foreign_keys = ON");
      const objects = await prefixedObjects(tx, record.prefix);
      for (const kind of ["trigger", "view", "table"]) {
        for (const object of objects.filter((o) => o.type === kind)) {
          await tx.exec(`DROP ${kind.toUpperCase()} IF EXISTS ${quote(object.name)}`);
        }
      }
      await tx.run(`DELETE FROM ${BOTS_TABLE} WHERE id = ?`, id);
    });
    return true;
  }

  async addThread(thread: ThreadRecord): Promise<void> {
    await this.#db.run(
      `INSERT INTO ${THREADS_TABLE} (bot_id, conversation_id, parent_conversation_id, forked_at_entry, title, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      thread.botId,
      thread.conversationId,
      thread.parentConversationId,
      thread.forkedAt,
      thread.title,
      thread.createdAt,
    );
  }

  async listThreads(botId: string): Promise<ThreadRecord[]> {
    const rows = await this.#db.all<ThreadRow>(
      `SELECT * FROM ${THREADS_TABLE} WHERE bot_id = ? ORDER BY created_at DESC, conversation_id`,
      botId,
    );
    return rows.map(toThread);
  }

  /** Woven's `updateConversationTitleIfCurrent`: set the title only while it is still empty. */
  async setThreadTitleIfUntitled(
    botId: string,
    conversationId: number,
    title: string,
  ): Promise<boolean> {
    const clean = title.trim();
    if (!clean) return false;
    const updated = await this.#db.get<{ conversation_id: number }>(
      `UPDATE ${THREADS_TABLE} SET title = ? WHERE bot_id = ? AND conversation_id = ? AND title = '' RETURNING conversation_id`,
      clean,
      botId,
      conversationId,
    );
    return updated !== undefined;
  }

  /** Threads whose title contains every whitespace-separated term (case-insensitive). */
  async searchThreads(botId: string, query: string): Promise<ThreadRecord[]> {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.listThreads(botId);
    const likeEscape = (term: string) => term.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await this.#db.all<ThreadRow>(
      `SELECT * FROM ${THREADS_TABLE} WHERE bot_id = ? ${terms
        .map(() => "AND lower(title) LIKE ? ESCAPE '\\'")
        .join(" ")} ORDER BY created_at DESC, conversation_id`,
      botId,
      ...terms.map((term) => `%${likeEscape(term)}%`),
    );
    return rows.map(toThread);
  }

  async getThread(botId: string, conversationId: number): Promise<ThreadRecord | undefined> {
    const row = await this.#db.get<ThreadRow>(
      `SELECT * FROM ${THREADS_TABLE} WHERE bot_id = ? AND conversation_id = ?`,
      botId,
      conversationId,
    );
    return row ? toThread(row) : undefined;
  }
}
