import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const BASE_DATA_DIR = process.env.VERCEL ? '/tmp' : process.cwd();
const DB_FILE = path.resolve(BASE_DATA_DIR, '.bling_tokens.db');
const LEGACY_TOKENS_FILE = path.resolve(BASE_DATA_DIR, '.bling_tokens.json');

export const BLING_ACCESS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours (21600s)

export interface BlingTokenRecord {
  id: number;
  access_token: string;
  refresh_token: string;
  expires_at: number; // UTC timestamp in ms
  expires_at_iso: string;
  expires_in: number;
  token_type: string;
  scope: string;
  obtained_at: number;
  updated_at: number;
}

interface SqliteDbLike {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

let dbInstance: SqliteDbLike | null = null;
let sqliteUnavailable = false;
let memoryTokenFallback: BlingTokenRecord | null = null;

function getDb(): SqliteDbLike | null {
  if (dbInstance) return dbInstance;
  if (sqliteUnavailable || process.env.VERCEL) return null;

  try {
    const baseHref =
      typeof import.meta?.url === 'string'
        ? import.meta.url
        : path.resolve(process.cwd(), 'package.json');
    const req = createRequire(baseHref);
    const sqliteMod = req('node:sqlite') as { DatabaseSync?: new (file: string) => SqliteDbLike };
    if (!sqliteMod?.DatabaseSync) {
      sqliteUnavailable = true;
      return null;
    }

    const db = new sqliteMod.DatabaseSync(DB_FILE);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS bling_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        expires_at_iso TEXT NOT NULL,
        expires_in INTEGER NOT NULL DEFAULT 21600,
        token_type TEXT NOT NULL DEFAULT 'Bearer',
        scope TEXT NOT NULL DEFAULT '',
        obtained_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    dbInstance = db;
    return dbInstance;
  } catch {
    sqliteUnavailable = true;
    return null;
  }
}

/**
 * Reads the persisted Bling OAuth token row from the bling_tokens table (or /tmp JSON on Vercel).
 * Auto-migrates legacy .bling_tokens.json or environment variables on first run.
 */
export function getBlingTokenFromDb(): BlingTokenRecord | null {
  try {
    const db = getDb();
    if (db) {
      const row = db
        .prepare(
          `SELECT id, access_token, refresh_token, expires_at, expires_at_iso, expires_in, token_type, scope, obtained_at, updated_at
           FROM bling_tokens WHERE id = 1 LIMIT 1`
        )
        .get() as BlingTokenRecord | undefined;

      if (row && (row.access_token || row.refresh_token)) {
        return row;
      }
    } else if (memoryTokenFallback && (memoryTokenFallback.access_token || memoryTokenFallback.refresh_token)) {
      return memoryTokenFallback;
    }

    // Migrate / read from JSON file in BASE_DATA_DIR (/tmp on Vercel)
    if (fs.existsSync(LEGACY_TOKENS_FILE)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(LEGACY_TOKENS_FILE, 'utf-8'));
        if (parsed?.access_token || parsed?.refresh_token) {
          const expiresInSec = Number(parsed.expires_in) || 21600;
          const obtainedAt = Number(parsed.obtained_at) || Date.now();
          const expiresAt = Number(parsed.expires_at) || obtainedAt + expiresInSec * 1000;
          return upsertBlingTokenInDb({
            access_token: String(parsed.access_token || ''),
            refresh_token: String(parsed.refresh_token || ''),
            expires_at: expiresAt,
            expires_in: expiresInSec,
            token_type: String(parsed.token_type || 'Bearer'),
            scope: String(parsed.scope || ''),
            obtained_at: obtainedAt
          });
        }
      } catch {
        // ignore corrupted legacy file
      }
    }

    // Bootstrap from environment variables if configured
    const envAccess = (process.env.BLING_ACCESS_TOKEN || '').trim();
    const envRefresh = (process.env.BLING_REFRESH_TOKEN || '').trim();
    if (envAccess || envRefresh) {
      const now = Date.now();
      const expiresAt = envAccess ? now + BLING_ACCESS_TTL_MS : 0;
      return upsertBlingTokenInDb({
        access_token: envAccess,
        refresh_token: envRefresh,
        expires_at: expiresAt,
        expires_in: 21600,
        token_type: 'Bearer',
        scope: '',
        obtained_at: envAccess ? now : 0
      });
    }
  } catch (err) {
    console.warn('[Bling DB] Error reading bling_tokens table:', err);
  }

  return null;
}

/**
 * Atomically saves/overwrites BOTH access_token, refresh_token, and expires_at (now + 6h)
 * inside the bling_tokens table (or /tmp JSON + memory on Vercel).
 */
export function upsertBlingTokenInDb(input: {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  obtained_at?: number;
}): BlingTokenRecord {
  const now = Date.now();
  const expiresInSec = Number(input.expires_in) || 21600; // 6 hours default
  const obtainedAt = input.obtained_at !== undefined ? input.obtained_at : now;
  const expiresAt =
    input.expires_at !== undefined
      ? input.expires_at
      : obtainedAt + expiresInSec * 1000;
  const expiresAtIso = new Date(expiresAt).toISOString();
  const tokenType = input.token_type || 'Bearer';
  const scope = input.scope || '';

  const record: BlingTokenRecord = {
    id: 1,
    access_token: input.access_token,
    refresh_token: input.refresh_token,
    expires_at: expiresAt,
    expires_at_iso: expiresAtIso,
    expires_in: expiresInSec,
    token_type: tokenType,
    scope,
    obtained_at: obtainedAt,
    updated_at: now
  };

  memoryTokenFallback = record;

  const db = getDb();
  if (db) {
    db.prepare(
      `INSERT INTO bling_tokens (
        id, access_token, refresh_token, expires_at, expires_at_iso, expires_in, token_type, scope, obtained_at, updated_at
      ) VALUES (
        1, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        expires_at_iso = excluded.expires_at_iso,
        expires_in = excluded.expires_in,
        token_type = excluded.token_type,
        scope = excluded.scope,
        obtained_at = excluded.obtained_at,
        updated_at = excluded.updated_at`
    ).run(
      input.access_token,
      input.refresh_token,
      expiresAt,
      expiresAtIso,
      expiresInSec,
      tokenType,
      scope,
      obtainedAt,
      now
    );
  } else {
    try {
      fs.writeFileSync(LEGACY_TOKENS_FILE, JSON.stringify(record, null, 2), 'utf-8');
    } catch {
      // ignore if /tmp write fails
    }
  }

  return record;
}

export function clearBlingTokenFromDb(): void {
  memoryTokenFallback = null;
  try {
    const db = getDb();
    if (db) {
      db.prepare('DELETE FROM bling_tokens WHERE id = 1').run();
    }
    if (fs.existsSync(LEGACY_TOKENS_FILE)) {
      fs.unlinkSync(LEGACY_TOKENS_FILE);
    }
  } catch (err) {
    console.warn('[Bling DB] Error clearing bling_tokens table:', err);
  }
}
