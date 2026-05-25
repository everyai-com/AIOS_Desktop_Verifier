// Cheap, fast checks against the artifact and installed bundle BEFORE we launch the app.
// These catch packaging-layer regressions (broken signing, missing notarization staple,
// Gatekeeper rejection) in seconds, without paying the cost of a full UI probe.

import { execa } from 'execa';
import type { Platform } from './types.js';

export interface PreflightCheck {
  id: string;
  description: string;
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  hasFailures: boolean;
}

// macOS: codesign --verify, spctl Gatekeeper assessment, stapler validate.
async function preflightMac(appPath: string): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  // 1. Code signature is intact and valid for every nested binary.
  const cs = await execa('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    reject: false,
  });
  checks.push({
    id: 'codesign-verify',
    description: 'codesign --verify --deep --strict',
    ok: cs.exitCode === 0,
    detail: cs.exitCode === 0 ? 'signature valid' : (cs.stderr || cs.stdout || `exit ${cs.exitCode}`),
  });

  // 2. Gatekeeper assesses the bundle as launchable.
  const sp = await execa('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], {
    reject: false,
  });
  checks.push({
    id: 'gatekeeper-assess',
    description: 'spctl --assess (Gatekeeper)',
    ok: sp.exitCode === 0,
    detail: sp.exitCode === 0 ? (sp.stderr || 'accepted') : (sp.stderr || sp.stdout || `exit ${sp.exitCode}`),
  });

  // 3. Notarization ticket is stapled. Catches the case where notarization succeeded
  //    but the ticket was never stapled — invisible until Gatekeeper sees it offline.
  const st = await execa('xcrun', ['stapler', 'validate', appPath], { reject: false });
  checks.push({
    id: 'stapler-validate',
    description: 'xcrun stapler validate (notarization staple)',
    ok: st.exitCode === 0,
    detail: st.exitCode === 0 ? 'staple present' : (st.stdout || st.stderr || `exit ${st.exitCode}`),
  });

  return checks;
}

// Windows: signtool verify on the installer (we keep the .exe around in downloads/).
async function preflightWin(installerPath: string): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const st = await execa('signtool', ['verify', '/pa', '/v', installerPath], { reject: false });
  checks.push({
    id: 'signtool-verify',
    description: 'signtool verify /pa (Authenticode signature)',
    ok: st.exitCode === 0,
    detail: st.exitCode === 0 ? 'signature valid' : (st.stdout || st.stderr || `exit ${st.exitCode}`),
  });
  return checks;
}

export async function runPreflight(
  platform: Platform,
  appPath: string,
  installerPath: string,
): Promise<PreflightResult> {
  const checks =
    platform === 'darwin' ? await preflightMac(appPath) : await preflightWin(installerPath);
  return { checks, hasFailures: checks.some((c) => !c.ok) };
}

export function formatPreflight(result: PreflightResult): string {
  return result.checks
    .map((c) => `  ${c.ok ? '[ok]' : '[FAIL]'} ${c.description} — ${c.detail.split('\n')[0]}`)
    .join('\n');
}
