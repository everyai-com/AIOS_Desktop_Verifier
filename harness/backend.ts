// Backend introspection — read what the app wrote, don't just trust the UI.

import Database, { type Database as DB } from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// AIOS Desktop's userData path. The app calls app.setPath('userData', ...) at startup,
// so the `--user-data-dir` CLI flag is ignored on this build. We probe the actual
// platform-standard location.
function platformUserDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'aios-desktop');
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming');
    return path.join(base, 'aios-desktop');
  }
  return path.join(homedir(), '.config', 'aios-desktop');
}

// Resolve the settings.db path. We try the explicit userDataDir (in case a future build
// honors --user-data-dir), then fall back to the platform-standard location. Returns the
// first path that actually exists. If none do, returns the explicit path so error messages
// stay actionable.
export function dbPath(userDataDir: string): string {
  const candidates = [
    path.join(userDataDir, 'settings.db'),
    path.join(platformUserDataDir(), 'settings.db'),
    // Some Electron apps put a subdir under userData
    path.join(platformUserDataDir(), 'Local Storage', 'settings.db'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

export function openDb(userDataDir: string): DB {
  return new Database(dbPath(userDataDir), { readonly: true, fileMustExist: true });
}

export function tryOpenDb(userDataDir: string): DB | null {
  try {
    return openDb(userDataDir);
  } catch {
    return null;
  }
}

export interface AssertRowOptions {
  table: string;
  where?: string;
  message: string;
}

export function assertRow(db: DB, opts: AssertRowOptions): void {
  const sql = opts.where
    ? `SELECT COUNT(*) AS n FROM ${opts.table} WHERE ${opts.where}`
    : `SELECT COUNT(*) AS n FROM ${opts.table}`;
  const row = db.prepare(sql).get() as { n: number };
  if (!row || row.n === 0) {
    throw new Error(`${opts.message} (query: ${sql})`);
  }
}

export function listTables(db: DB): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

// Tail the sidecar log. Probes capture main-process stderr separately via app-driver;
// this is for any aios-host.log file the app or sidecar might write into the userData dir.
export async function tailSidecarLog(logDir: string, lines = 100): Promise<string> {
  const candidates = [
    path.join(logDir, 'aios-host.log'),
    path.join(logDir, 'sidecar.log'),
    path.join(logDir, 'main-stderr.log'), // captured by app-driver
    path.join(platformUserDataDir(), 'logs', 'main.log'),
    path.join(platformUserDataDir(), 'aios-host.log'),
  ];
  try {
    const entries = await readdir(logDir);
    for (const e of entries) {
      if (e.endsWith('.log')) candidates.push(path.join(logDir, e));
    }
  } catch { /* logDir may not exist */ }

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      const text = await readFile(candidate, 'utf8');
      const all = text.split('\n');
      return all.slice(-lines).join('\n');
    } catch { /* try next */ }
  }
  return '(no sidecar log found)';
}
