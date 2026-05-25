// Boot an installed AIOS Desktop build under Playwright's Electron driver.
// Each probe gets:
//   - a fresh --user-data-dir (state isolation)
//   - a Playwright trace recording (huge debugging win on failure)
//   - the renderer console captured to a log file
//   - the main process stderr captured to a log file

import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { execa } from 'execa';
import { createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { Platform } from './types.js';

export interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
  // Evidence paths, valid for the lifetime of the launched app + after close.
  evidence: {
    tracePath: string;
    consoleLogPath: string;
    stderrLogPath: string;
  };
  // Internal handles closed by closeApp().
  _consoleStream: WriteStream;
  _stderrStream: WriteStream;
}

function resolveExecutable(appPath: string, platform: Platform): string {
  if (platform === 'darwin') {
    // appPath is /path/to/Foo.app — Playwright wants the binary inside it.
    const appName = path.basename(appPath, '.app');
    return path.join(appPath, 'Contents', 'MacOS', appName);
  }
  return appPath;
}

export async function launchApp(
  appPath: string,
  userDataDir: string,
  platform: Platform,
  logDir: string,
  extraEnv: Record<string, string> = {},
): Promise<LaunchedApp> {
  const executablePath = resolveExecutable(appPath, platform);

  const tracePath = path.join(logDir, 'trace.zip');
  const consoleLogPath = path.join(logDir, 'renderer-console.log');
  const stderrLogPath = path.join(logDir, 'main-stderr.log');
  const consoleStream = createWriteStream(consoleLogPath, { flags: 'a' });
  const stderrStream = createWriteStream(stderrLogPath, { flags: 'a' });

  const electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      AIOS_VERIFIER: '1',
      // Signal to the app it's in a test context. Honored when the app implements
      // a test-mode IPC; harmless otherwise.
      AIOS_TEST_MODE: '1',
      ...extraEnv,
    },
    timeout: 60_000,
  });

  // Capture main-process stderr/stdout. Critical for diagnosing why the sidecar didn't start.
  electronApp.process().stderr?.on('data', (chunk: Buffer) => {
    stderrStream.write(chunk);
  });
  electronApp.process().stdout?.on('data', (chunk: Buffer) => {
    stderrStream.write(chunk);
  });

  const page = await electronApp.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState('domcontentloaded');

  // Start Playwright trace AFTER the first window — tracing covers all subsequent actions
  // and renders into a viewable artifact on failure (npx playwright show-trace trace.zip).
  await page.context().tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });

  // Capture renderer console messages to a log file. Catches JS errors mid-probe.
  page.on('console', (msg) => {
    consoleStream.write(`[${msg.type()}] ${msg.text()}\n`);
  });
  page.on('pageerror', (err) => {
    consoleStream.write(`[pageerror] ${err.message}\n${err.stack ?? ''}\n`);
  });

  return {
    electronApp,
    page,
    evidence: { tracePath, consoleLogPath, stderrLogPath },
    _consoleStream: consoleStream,
    _stderrStream: stderrStream,
  };
}

export async function closeApp(launched: LaunchedApp, platform: Platform): Promise<void> {
  // Stop tracing and write the zip BEFORE closing the app (close drops the context).
  try {
    await launched.page.context().tracing.stop({ path: launched.evidence.tracePath });
  } catch { /* trace stop is best-effort */ }

  try {
    await launched.electronApp.close();
  } catch { /* already gone */ }

  launched._consoleStream.end();
  launched._stderrStream.end();

  // Belt-and-braces: kill any lingering aios-host (PyInstaller-bundled Python sidecar)
  // that didn't exit when the parent did.
  if (platform === 'darwin') {
    await execa('pkill', ['-f', 'aios-host'], { reject: false });
  } else {
    await execa('taskkill', ['/F', '/IM', 'aios-host.exe'], { reject: false });
  }
}
