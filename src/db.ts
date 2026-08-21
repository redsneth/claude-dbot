import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { config } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";

const db = new DatabaseSync(join(config.dataDir, "dbot.sqlite"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tokens (
    owner_id   TEXT PRIMARY KEY,
    token_enc  TEXT NOT NULL,
    label      TEXT,
    created_at INTEGER NOT NULL,
    last_used  INTEGER NOT NULL DEFAULT 0
  );
  -- grantee '*' means "everyone on the server"
  CREATE TABLE IF NOT EXISTS shares (
    owner_id TEXT NOT NULL,
    grantee  TEXT NOT NULL,
    PRIMARY KEY (owner_id, grantee)
  );
  CREATE TABLE IF NOT EXISTS cooldowns (
    owner_id TEXT PRIMARY KEY,
    until    INTEGER NOT NULL,
    reason   TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    channel_id TEXT NOT NULL,
    project    TEXT NOT NULL,
    session_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, project)
  );
  CREATE TABLE IF NOT EXISTS channel_projects (
    channel_id TEXT PRIMARY KEY,
    project    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    owner_id      TEXT NOT NULL,
    requester_id  TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd      REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_owner_ts ON usage_log (owner_id, ts);
  -- Latest rate-limit window snapshot per token, from the SDK's rate_limit_event.
  CREATE TABLE IF NOT EXISTS token_status (
    owner_id    TEXT PRIMARY KEY,
    utilization REAL,
    limit_type  TEXT,
    updated_at  INTEGER NOT NULL
  );
`);

// Migration for databases created before donor model policies existed.
try {
  db.exec(`ALTER TABLE tokens ADD COLUMN max_tier TEXT NOT NULL DEFAULT 'any'`);
} catch {
  // column already exists
}

// --- tokens ---

export function setToken(ownerId: string, token: string, label?: string): void {
  db.prepare(
    `INSERT INTO tokens (owner_id, token_enc, label, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET token_enc = excluded.token_enc, label = excluded.label`,
  ).run(ownerId, encrypt(token), label ?? null, Date.now());
}

export function deleteToken(ownerId: string): void {
  db.prepare(`DELETE FROM tokens WHERE owner_id = ?`).run(ownerId);
  db.prepare(`DELETE FROM shares WHERE owner_id = ?`).run(ownerId);
  db.prepare(`DELETE FROM cooldowns WHERE owner_id = ?`).run(ownerId);
}

export function hasToken(ownerId: string): boolean {
  return db.prepare(`SELECT 1 FROM tokens WHERE owner_id = ?`).get(ownerId) !== undefined;
}

export function getDecryptedToken(ownerId: string): string | undefined {
  const row = db.prepare(`SELECT token_enc FROM tokens WHERE owner_id = ?`).get(ownerId) as
    | { token_enc: string }
    | undefined;
  return row ? decrypt(row.token_enc) : undefined;
}

export function touchToken(ownerId: string): void {
  db.prepare(`UPDATE tokens SET last_used = ? WHERE owner_id = ?`).run(Date.now(), ownerId);
}

export function setMaxTier(ownerId: string, maxTier: string): void {
  db.prepare(`UPDATE tokens SET max_tier = ? WHERE owner_id = ?`).run(maxTier, ownerId);
}

export function getMaxTier(ownerId: string): string {
  const row = db.prepare(`SELECT max_tier FROM tokens WHERE owner_id = ?`).get(ownerId) as
    | { max_tier: string }
    | undefined;
  return row?.max_tier ?? "any";
}

// --- usage tracking ---

export function logUsage(entry: {
  ownerId: string;
  requesterId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}): void {
  db.prepare(
    `INSERT INTO usage_log (ts, owner_id, requester_id, model, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(Date.now(), entry.ownerId, entry.requesterId, entry.model, entry.inputTokens, entry.outputTokens, entry.costUsd);
}

export interface UsageSummary {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  byRequester: { requesterId: string; runs: number; costUsd: number }[];
  byModel: { model: string; runs: number; costUsd: number }[];
}

export function usageSummary(ownerId: string, sinceMs: number): UsageSummary {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM usage_log WHERE owner_id = ? AND ts >= ?`,
    )
    .get(ownerId, sinceMs) as { runs: number; input_tokens: number; output_tokens: number; cost_usd: number };
  const byRequester = db
    .prepare(
      `SELECT requester_id, COUNT(*) AS runs, COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM usage_log WHERE owner_id = ? AND ts >= ?
       GROUP BY requester_id ORDER BY cost_usd DESC LIMIT 10`,
    )
    .all(ownerId, sinceMs) as { requester_id: string; runs: number; cost_usd: number }[];
  const byModel = db
    .prepare(
      `SELECT model, COUNT(*) AS runs, COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM usage_log WHERE owner_id = ? AND ts >= ?
       GROUP BY model ORDER BY cost_usd DESC`,
    )
    .all(ownerId, sinceMs) as { model: string; runs: number; cost_usd: number }[];
  return {
    runs: totals.runs,
    inputTokens: totals.input_tokens,
    outputTokens: totals.output_tokens,
    costUsd: totals.cost_usd,
    byRequester: byRequester.map((r) => ({ requesterId: r.requester_id, runs: r.runs, costUsd: r.cost_usd })),
    byModel: byModel.map((r) => ({ model: r.model, runs: r.runs, costUsd: r.cost_usd })),
  };
}

export function setTokenStatus(ownerId: string, utilization: number | undefined, limitType: string | undefined): void {
  db.prepare(
    `INSERT INTO token_status (owner_id, utilization, limit_type, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET utilization = excluded.utilization,
       limit_type = excluded.limit_type, updated_at = excluded.updated_at`,
  ).run(ownerId, utilization ?? null, limitType ?? null, Date.now());
}

export function getTokenStatus(
  ownerId: string,
): { utilization: number | null; limitType: string | null; updatedAt: number } | undefined {
  const row = db.prepare(`SELECT utilization, limit_type, updated_at FROM token_status WHERE owner_id = ?`).get(ownerId) as
    | { utilization: number | null; limit_type: string | null; updated_at: number }
    | undefined;
  return row ? { utilization: row.utilization, limitType: row.limit_type, updatedAt: row.updated_at } : undefined;
}

// --- shares ---

export function addShare(ownerId: string, grantee: string): void {
  db.prepare(`INSERT OR IGNORE INTO shares (owner_id, grantee) VALUES (?, ?)`).run(ownerId, grantee);
}

export function removeShare(ownerId: string, grantee: string): void {
  db.prepare(`DELETE FROM shares WHERE owner_id = ? AND grantee = ?`).run(ownerId, grantee);
}

export function listSharesByOwner(ownerId: string): string[] {
  return (db.prepare(`SELECT grantee FROM shares WHERE owner_id = ?`).all(ownerId) as { grantee: string }[]).map(
    (r) => r.grantee,
  );
}

/** Token owners who have shared with this user (directly or with everyone), excluding the user. */
export function donorsFor(userId: string): string[] {
  return (
    db
      .prepare(
        `SELECT s.owner_id FROM shares s
         JOIN tokens t ON t.owner_id = s.owner_id
         WHERE (s.grantee = ? OR s.grantee = '*') AND s.owner_id != ?
         ORDER BY t.last_used ASC`,
      )
      .all(userId, userId) as { owner_id: string }[]
  ).map((r) => r.owner_id);
}

// --- cooldowns ---

export function setCooldown(ownerId: string, untilMs: number, reason: string): void {
  db.prepare(
    `INSERT INTO cooldowns (owner_id, until, reason) VALUES (?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET until = excluded.until, reason = excluded.reason`,
  ).run(ownerId, untilMs, reason);
}

export function getCooldown(ownerId: string): { until: number; reason: string | null } | undefined {
  const row = db.prepare(`SELECT until, reason FROM cooldowns WHERE owner_id = ?`).get(ownerId) as
    | { until: number; reason: string | null }
    | undefined;
  if (!row) return undefined;
  if (row.until <= Date.now()) {
    db.prepare(`DELETE FROM cooldowns WHERE owner_id = ?`).run(ownerId);
    return undefined;
  }
  return row;
}

// --- sessions ---

export function getSession(channelId: string, project: string): string | undefined {
  const row = db
    .prepare(`SELECT session_id FROM sessions WHERE channel_id = ? AND project = ?`)
    .get(channelId, project) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(channelId: string, project: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (channel_id, project, session_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, project) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
  ).run(channelId, project, sessionId, Date.now());
}

export function clearSessions(channelId: string): void {
  db.prepare(`DELETE FROM sessions WHERE channel_id = ?`).run(channelId);
}

// --- channel project defaults ---

export function getChannelProject(channelId: string): string | undefined {
  const row = db.prepare(`SELECT project FROM channel_projects WHERE channel_id = ?`).get(channelId) as
    | { project: string }
    | undefined;
  return row?.project;
}

export function setChannelProject(channelId: string, project: string): void {
  db.prepare(
    `INSERT INTO channel_projects (channel_id, project) VALUES (?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET project = excluded.project`,
  ).run(channelId, project);
}

export function clearChannelProject(channelId: string): void {
  db.prepare(`DELETE FROM channel_projects WHERE channel_id = ?`).run(channelId);
}
