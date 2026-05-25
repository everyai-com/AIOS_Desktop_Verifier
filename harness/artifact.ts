// Download a shipped AIOS Desktop artifact for a given release tag and install it on the
// current platform. Returns the absolute path to the installed .app or .exe.

import { execa } from 'execa';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Octokit } from '@octokit/rest';
import type { Platform } from './types.js';

interface ResolvedArtifact {
  apiUrl: string;       // GitHub API URL — works for private repos with a token
  filename: string;
  sizeBytes: number;
}

export async function resolveArtifact(
  owner: string,
  repo: string,
  tag: string,
  platform: Platform,
  octokit?: Octokit,
): Promise<ResolvedArtifact> {
  const kit = octokit ?? new Octokit({ auth: process.env.GITHUB_TOKEN });
  const { data } = await kit.repos.getReleaseByTag({ owner, repo, tag });

  const wantsExt = platform === 'darwin' ? '.dmg' : '.exe';
  // Prefer arm64 dmg on Apple Silicon; fall back to any .dmg if the only build is universal/intel.
  const isArm = process.arch === 'arm64';
  const dmgs = data.assets.filter((a) => a.name.toLowerCase().endsWith(wantsExt));
  const asset =
    (isArm && platform === 'darwin' ? dmgs.find((a) => /arm64|aarch64/i.test(a.name)) : undefined) ??
    dmgs.find((a) => !/arm64|aarch64/i.test(a.name)) ??
    dmgs[0];
  if (!asset) {
    throw new Error(
      `No ${wantsExt} asset on release ${tag} (found: ${data.assets.map((a) => a.name).join(', ')})`,
    );
  }
  return { apiUrl: asset.url, filename: asset.name, sizeBytes: asset.size };
}

export async function download(apiUrl: string, destPath: string): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  // Allow already-downloaded artifacts to be reused; saves bandwidth when iterating locally.
  try {
    const s = await stat(destPath);
    if (s.size > 0) return;
  } catch { /* not present */ }

  // Asset API URLs require Accept: application/octet-stream to return the binary
  // (otherwise they return JSON metadata). Works for private repos with a token.
  const headers: Record<string, string> = { Accept: 'application/octet-stream' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(apiUrl, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status} ${res.statusText}) for ${apiUrl}`);
  }
  await pipeline(res.body as any, createWriteStream(destPath));
}

export interface InstalledApp {
  appPath: string;       // path to .app (mac) or .exe (win)
  cleanup: () => Promise<void>;
}

export async function install(
  filePath: string,
  platform: Platform,
  installDir: string,
): Promise<InstalledApp> {
  // Always start from a clean install dir. Re-installing over an existing copy leaves
  // stale files in the bundle root which Gatekeeper rejects ("unsealed contents present").
  await rm(installDir, { recursive: true, force: true });
  await mkdir(installDir, { recursive: true });
  if (platform === 'darwin') return installDmg(filePath, installDir);
  if (platform === 'win32') return installExe(filePath, installDir);
  throw new Error(`Unsupported platform: ${platform}`);
}

async function installDmg(dmgPath: string, installDir: string): Promise<InstalledApp> {
  // Mount the DMG without showing it in Finder, copy the .app out, detach.
  const mountResult = await execa('hdiutil', ['attach', '-nobrowse', '-readonly', dmgPath], {
    stdio: 'pipe',
  });
  // Parse the mount point from hdiutil output (last whitespace-delimited column on the matching line)
  const mountPoint = mountResult.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/dev/'))
    .map((l) => l.split('\t').pop()?.trim())
    .filter(Boolean)
    .find((p) => p && p.startsWith('/Volumes/'));
  if (!mountPoint) throw new Error(`Could not find mount point in hdiutil output:\n${mountResult.stdout}`);

  try {
    const { stdout: lsOut } = await execa('ls', [mountPoint]);
    const appName = lsOut.split('\n').find((n) => n.endsWith('.app'));
    if (!appName) throw new Error(`No .app found in mounted DMG at ${mountPoint}`);

    const src = path.join(mountPoint, appName);
    const dest = path.join(installDir, appName);
    await execa('cp', ['-R', src, dest]);
    // Strip Gatekeeper quarantine attr so the app launches headlessly without prompts.
    await execa('xattr', ['-dr', 'com.apple.quarantine', dest], { reject: false });
    return {
      appPath: dest,
      cleanup: async () => {
        await execa('hdiutil', ['detach', '-quiet', mountPoint], { reject: false });
      },
    };
  } catch (e) {
    await execa('hdiutil', ['detach', '-quiet', mountPoint], { reject: false });
    throw e;
  }
}

async function installExe(exePath: string, installDir: string): Promise<InstalledApp> {
  // NSIS silent install. /D sets the install directory (must come last, unquoted, per NSIS).
  await execa(exePath, ['/S', `/D=${installDir}`], { windowsVerbatimArguments: true });
  // Discover the launcher executable.
  const { stdout } = await execa('powershell', [
    '-NoProfile',
    '-Command',
    `Get-ChildItem -Path '${installDir}' -Filter '*.exe' -Recurse | Select-Object -First 1 -ExpandProperty FullName`,
  ]);
  const appPath = stdout.trim();
  if (!appPath) throw new Error(`No .exe found under ${installDir} after install`);
  return {
    appPath,
    cleanup: async () => { /* leave install in place; CI runner is ephemeral */ },
  };
}
