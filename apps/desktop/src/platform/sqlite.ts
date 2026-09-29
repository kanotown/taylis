import type { Persistence, Snapshot } from "../sync/store";
import { emptySnapshot } from "../sync/store";
import type { ChannelState, MessageState, OutboxItem, UserPublic } from "../sync/types";

interface SqlDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)",
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, seq INTEGER, json TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS messages_channel_seq ON messages (channel_id, seq)",
  "CREATE TABLE IF NOT EXISTS outbox (client_msg_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL)",
];

/** Write-through SQLite persistence per server + user (tauri-plugin-sql). */
export class SqlitePersistence implements Persistence {
  private constructor(private readonly db: SqlDatabase) {}

  static async open(profile: string): Promise<SqlitePersistence> {
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    const db = (await Database.load(`sqlite:chikuwa-${profile}.db`)) as unknown as SqlDatabase;
    // Deleted rows are overwritten in the file, not only unlinked: a message deleted here, or the whole store at
    // sign-out (§11), must not stay readable in the .db.
    await db.execute("PRAGMA secure_delete = ON");
    for (const statement of SCHEMA) await db.execute(statement);
    return new SqlitePersistence(db);
  }

  async loadAll(): Promise<Snapshot> {
    const snapshot = emptySnapshot();
    for (const row of await this.db.select<{ key: string; value: string }[]>("SELECT key, value FROM meta")) {
      snapshot.meta[row.key] = row.value;
    }
    snapshot.users = parseRows<UserPublic>(await this.db.select<{ json: string }[]>("SELECT json FROM users"), "users");
    snapshot.channels = parseRows<ChannelState>(await this.db.select<{ json: string }[]>("SELECT json FROM channels"), "channels");
    snapshot.messages = parseRows<MessageState>(await this.db.select<{ json: string }[]>("SELECT json FROM messages"), "messages");
    snapshot.outbox = parseRows<OutboxItem>(await this.db.select<{ json: string }[]>("SELECT json FROM outbox ORDER BY created_at"), "outbox");
    return snapshot;
  }

  async saveMeta(key: string, value: string | null): Promise<void> {
    if (value === null) await this.db.execute("DELETE FROM meta WHERE key = $1", [key]);
    else await this.db.execute("INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  async saveUser(user: UserPublic): Promise<void> {
    await this.db.execute("INSERT INTO users (id, json) VALUES ($1, $2) ON CONFLICT(id) DO UPDATE SET json = excluded.json", [user.id, JSON.stringify(user)]);
  }

  async saveChannel(channel: ChannelState): Promise<void> {
    await this.db.execute("INSERT INTO channels (id, json) VALUES ($1, $2) ON CONFLICT(id) DO UPDATE SET json = excluded.json", [channel.id, JSON.stringify(channel)]);
  }

  async deleteChannel(channelId: string): Promise<void> {
    await this.db.execute("DELETE FROM channels WHERE id = $1", [channelId]);
  }

  async saveMessage(message: MessageState): Promise<void> {
    await this.db.execute(
      "INSERT INTO messages (id, channel_id, seq, json) VALUES ($1, $2, $3, $4) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, json = excluded.json",
      [message.id, message.channel_id, message.seq, JSON.stringify(message)],
    );
  }

  async deleteMessage(id: string): Promise<void> {
    await this.db.execute("DELETE FROM messages WHERE id = $1", [id]);
  }

  async clearMessages(channelId: string): Promise<void> {
    await this.db.execute("DELETE FROM messages WHERE channel_id = $1", [channelId]);
  }

  async saveOutbox(item: OutboxItem): Promise<void> {
    await this.db.execute(
      "INSERT INTO outbox (client_msg_id, created_at, json) VALUES ($1, $2, $3) ON CONFLICT(client_msg_id) DO UPDATE SET json = excluded.json",
      [item.client_msg_id, item.created_at, JSON.stringify(item)],
    );
  }

  async deleteOutbox(clientMsgId: string): Promise<void> {
    await this.db.execute("DELETE FROM outbox WHERE client_msg_id = $1", [clientMsgId]);
  }

  async deleteOlderMessages(channelId: string, beforeSeq: number): Promise<void> {
    await this.db.execute("DELETE FROM messages WHERE channel_id = $1 AND seq IS NOT NULL AND seq < $2", [channelId, beforeSeq]);
  }

  async clearAll(): Promise<void> {
    for (const table of ["meta", "users", "channels", "messages", "outbox"]) await this.db.execute(`DELETE FROM ${table}`);
    // The freed pages leave the file as well (secure_delete has zeroed them; a failed vacuum loses nothing).
    try {
      await this.db.execute("VACUUM");
    } catch (err) {
      console.warn("could not vacuum the local store", err);
    }
  }
}

/** A row that no longer parses is skipped (the next sync writes it again) instead of failing the start. */
function parseRows<T>(rows: { json: string }[], table: string): T[] {
  const parsed: T[] = [];
  for (const row of rows) {
    try {
      parsed.push(JSON.parse(row.json) as T);
    } catch {
      console.warn(`skipping a corrupt row in ${table}`);
    }
  }
  return parsed;
}
