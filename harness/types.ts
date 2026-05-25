// VerifierOS shared types.

export type Platform = 'darwin' | 'win32';

export interface ReleaseManifest {
  tag: string;
  version: string;
  platform: Platform;
  artifactUrl: string;
  artifactFilename: string;
  changedFeatures: string[];
}

export interface RunEnvironment {
  nodeVersion: string;
  playwrightVersion: string;
  osVersion: string;
  arch: string;
  runStartedAt: string; // ISO timestamp
  runnerHost: string;   // hostname or CI runner identifier
}

export interface ProbeContext {
  manifest: ReleaseManifest;
  appPath: string;
  installerPath: string; // path to the downloaded .dmg or .exe (preflight needs it on Windows)
  userDataDir: string;
  logDir: string;
  workDir: string;
}

export interface Probe {
  id: string;
  tags: string[];
  description: string;
  timeoutMs: number;
  run(ctx: ProbeContext): Promise<void>;
}

export type ProbeStatus = 'pass' | 'fail' | 'skip';

export interface ProbeResult {
  id: string;
  status: ProbeStatus;
  durationMs: number;
  error?: string;
  // Evidence paths — present whether or not the probe failed; the report links them on failure.
  screenshotPath?: string;
  tracePath?: string;
  consoleLogPath?: string;
  stderrLogPath?: string;
  sidecarLogTail?: string;
  preflightSummary?: string; // multi-line preflight check summary, if any ran
}

export interface ProbesConfig {
  smoke: string[];
  features: Record<string, string[]>;
}
