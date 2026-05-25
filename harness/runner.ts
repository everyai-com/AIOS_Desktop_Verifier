// Probe scheduler. Loads the registry, filters by CHANGES.yaml, runs each in isolation,
// captures evidence on failure, runs platform preflight before launching anything.

import { execa } from 'execa';
import { hostname } from 'node:os';
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { probes as allProbes } from '../probes/index.js';
import { tailSidecarLog } from './backend.js';
import { formatPreflight, runPreflight } from './preflight.js';
import type {
  Probe,
  ProbeContext,
  ProbeResult,
  ProbesConfig,
  ReleaseManifest,
  RunEnvironment,
} from './types.js';

export async function loadConfig(configPath: string): Promise<ProbesConfig> {
  const text = await readFile(configPath, 'utf8');
  const parsed = parseYaml(text) as ProbesConfig;
  return {
    smoke: parsed.smoke ?? [],
    features: parsed.features ?? {},
  };
}

export function selectProbes(config: ProbesConfig, changedFeatures: string[]): Probe[] {
  const wanted = new Set<string>(config.smoke);
  for (const feature of changedFeatures) {
    const ids = config.features[feature];
    if (ids) for (const id of ids) wanted.add(id);
  }
  return allProbes.filter((p) => wanted.has(p.id));
}

export async function captureRunEnvironment(): Promise<RunEnvironment> {
  const playwrightVersion = await readPlaywrightVersion();
  let osVersion = '';
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execa('sw_vers', ['-productVersion']);
      osVersion = `macOS ${stdout.trim()}`;
    } else if (process.platform === 'win32') {
      const { stdout } = await execa('cmd', ['/c', 'ver']);
      osVersion = stdout.trim();
    } else {
      osVersion = process.platform;
    }
  } catch { /* keep empty */ }

  return {
    nodeVersion: process.version,
    playwrightVersion,
    osVersion,
    arch: process.arch,
    runStartedAt: new Date().toISOString(),
    runnerHost: process.env.GITHUB_ACTIONS ? `github-actions/${process.env.RUNNER_OS}` : hostname(),
  };
}

async function readPlaywrightVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(
        path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'node_modules', 'playwright', 'package.json'),
        'utf8',
      ),
    );
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface RunnerOptions {
  manifest: ReleaseManifest;
  installedAppPath: string;
  installerPath: string;
  reportsDir: string;
}

export async function runAll(probes: Probe[], opts: RunnerOptions): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  // Preflight runs ONCE per verification (against the installed bundle / installer),
  // and its summary is attached to the first probe's result for visibility.
  let preflightSummary: string | undefined;
  try {
    const preflight = await runPreflight(
      opts.manifest.platform,
      opts.installedAppPath,
      opts.installerPath,
    );
    preflightSummary = formatPreflight(preflight);
    if (preflight.hasFailures) {
      // Synthesize a failure result so the report surfaces it as a first-class probe failure.
      results.push({
        id: 'preflight',
        status: 'fail',
        durationMs: 0,
        error: 'Artifact preflight checks failed — see preflight summary',
        preflightSummary,
      });
    } else {
      results.push({
        id: 'preflight',
        status: 'pass',
        durationMs: 0,
        preflightSummary,
      });
    }
  } catch (e) {
    preflightSummary = `preflight crashed: ${e instanceof Error ? e.message : String(e)}`;
    results.push({ id: 'preflight', status: 'fail', durationMs: 0, error: preflightSummary });
  }

  for (const probe of probes) {
    const workDir = await mkdtemp(path.join(tmpdir(), `verifier-${probe.id}-`));
    const userDataDir = path.join(workDir, 'userData');
    const logDir = path.join(workDir, 'logs');
    await mkdir(userDataDir, { recursive: true });
    await mkdir(logDir, { recursive: true });

    const ctx: ProbeContext = {
      manifest: opts.manifest,
      appPath: opts.installedAppPath,
      installerPath: opts.installerPath,
      userDataDir,
      logDir,
      workDir,
    };

    const started = Date.now();
    const result: ProbeResult = { id: probe.id, status: 'pass', durationMs: 0 };

    try {
      await withTimeout(probe.run(ctx), probe.timeoutMs, probe.id);
    } catch (e) {
      result.status = 'fail';
      result.error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
      result.sidecarLogTail = await tailSidecarLog(logDir).catch(() => '(log capture failed)');
    } finally {
      result.durationMs = Date.now() - started;
      // Attach evidence paths if the files actually exist.
      result.screenshotPath = await existsOrUndef(path.join(logDir, 'failure.png'));
      result.tracePath = await existsOrUndef(path.join(logDir, 'trace.zip'));
      result.consoleLogPath = await existsOrUndef(path.join(logDir, 'renderer-console.log'));
      result.stderrLogPath = await existsOrUndef(path.join(logDir, 'main-stderr.log'));
      results.push(result);
    }
  }

  return results;
}

async function existsOrUndef(p: string): Promise<string | undefined> {
  try {
    const s = await stat(p);
    if (s.size > 0) return p;
    return undefined;
  } catch {
    return undefined;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`Probe ${label} exceeded timeout of ${ms}ms`)), ms),
    ),
  ]);
}
