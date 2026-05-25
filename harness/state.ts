// State abstraction for probes.
//
// Two backends, in priority order:
//   1. test-mode IPC — calls window.aios?.testGetState?.() in the renderer. Returns a
//      typed snapshot the app explicitly exposes for testing. Decouples probes from
//      internal schema.
//   2. SQLite read — opens settings.db directly. Schema-coupled, brittle across migrations,
//      but works today without app changes.
//
// To enable the IPC path, the app needs to expose `window.aios.testGetState` from preload,
// only when AIOS_TEST_MODE=1 is set in env. Until then, probes use SQLite.

import type { Page } from 'playwright';
import { listTables, tryOpenDb } from './backend.js';

export interface AppStateSnapshot {
  sessionCount: number;
  dbMissing?: boolean;   // true when SQLite file wasn't found at any known path
  source: 'ipc' | 'sqlite' | 'unavailable';
  messageCount?: number;
  selectedModel?: string;
  connectedServices?: string[];
}

export async function getAppState(page: Page, userDataDir: string): Promise<AppStateSnapshot> {
  // Try test-mode IPC first.
  try {
    const fromIpc = (await page.evaluate(async () => {
      // window.aios is app-injected, not part of verifier types
      const fn = (window as unknown as { aios?: { testGetState?: () => Promise<unknown> } })
        .aios?.testGetState;
      if (typeof fn !== 'function') return null;
      return await fn();
    })) as Partial<AppStateSnapshot> | null;
    if (fromIpc && typeof fromIpc.sessionCount === 'number') {
      return { ...fromIpc, sessionCount: fromIpc.sessionCount, source: 'ipc' };
    }
  } catch { /* IPC unavailable — fall through */ }

  // Fallback: read SQLite directly.
  const db = tryOpenDb(userDataDir);
  if (!db) {
    return { sessionCount: 0, dbMissing: true, source: 'unavailable' };
  }
  try {
    const tables = listTables(db);
    const sessionTable = tables.find((t) =>
      /^(session|sessions|chat_session|chat_sessions)$/.test(t),
    );
    if (!sessionTable) {
      return { sessionCount: 0, source: 'sqlite' };
    }
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${sessionTable}`).get() as { n: number };
    return { sessionCount: row?.n ?? 0, source: 'sqlite' };
  } finally {
    db.close();
  }
}
