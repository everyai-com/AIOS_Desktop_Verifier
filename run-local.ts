// VerifierOS local CLI.
//
// Usage:
//   tsx run-local.ts --tag v0.2.24                          # auto-detects current platform
//   tsx run-local.ts --tag v0.2.24 --platform darwin
//   tsx run-local.ts --tag v0.2.24 --owner everyai-com --repo AIOS_Desktop
//
// Pre-publish mode (skip GitHub download, use a local artifact):
//   tsx run-local.ts --tag v0.2.24-rc1 --artifact /path/to/built.dmg
//
// Writes the report to ../verification-reports/<tag>-<platform>.md relative to the
// scripts directory (i.e. into the workspace root's verification-reports/).

import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { Octokit } from '@octokit/rest';

import { download, install, resolveArtifact } from './harness/artifact.js';
import { captureRunEnvironment, loadConfig, runAll, selectProbes } from './harness/runner.js';
import { formatMarkdown, writeReportFile } from './harness/report.js';
import type { Platform, ReleaseManifest } from './harness/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function currentPlatform(): Platform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  throw new Error(`Unsupported host platform: ${process.platform}. Use macOS or Windows.`);
}

interface ChangesFile {
  releases?: Array<{ tag: string; features?: string[] }>;
}

async function fetchChangedFeatures(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string,
): Promise<string[]> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: 'CHANGES.yaml', ref: tag });
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return [];
    const raw = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed = parseYaml(raw) as ChangesFile;
    const entry = parsed.releases?.find((r) => r.tag === tag);
    return entry?.features ?? [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tag: { type: 'string' },
      platform: { type: 'string' },
      owner: { type: 'string', default: 'everyai-com' },
      repo: { type: 'string', default: 'AIOS_Desktop' },
      artifact: { type: 'string' },         // pre-publish mode: local file path
      'reports-dir': { type: 'string' },
    },
  });

  if (!values.tag) {
    console.error('Missing --tag (e.g. --tag v0.2.24)');
    process.exit(2);
  }

  const tag = values.tag;
  const platform = (values.platform as Platform | undefined) ?? currentPlatform();
  const owner = values.owner!;
  const repo = values.repo!;
  const localArtifact = values.artifact ? path.resolve(values.artifact) : undefined;
  const reportsDir = values['reports-dir']
    ? path.resolve(values['reports-dir'])
    : path.resolve(HERE, '..', 'verification-reports');

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const configPath = path.join(HERE, 'probes.config.yaml');
  const config = await loadConfig(configPath);
  const env = await captureRunEnvironment();

  let installerPath: string;
  let filename: string;
  let sizeBytes: number;

  if (localArtifact) {
    console.error(`[verifier] Pre-publish mode: using local artifact ${localArtifact}`);
    installerPath = localArtifact;
    filename = path.basename(localArtifact);
    sizeBytes = (await stat(localArtifact)).size;
  } else {
    console.error(`[verifier] Resolving ${owner}/${repo}@${tag} for ${platform}…`);
    const resolved = await resolveArtifact(owner, repo, tag, platform, octokit);
    filename = resolved.filename;
    sizeBytes = resolved.sizeBytes;
    const downloadsDir = path.join(HERE, 'downloads');
    await mkdir(downloadsDir, { recursive: true });
    installerPath = path.join(downloadsDir, filename);
    console.error(`[verifier] Downloading ${filename} (${(sizeBytes / 1e6).toFixed(1)} MB)…`);
    await download(resolved.apiUrl, installerPath);
  }

  const changedFeatures = localArtifact
    ? []
    : await fetchChangedFeatures(octokit, owner, repo, tag);
  if (changedFeatures.length === 0) {
    console.error('[verifier] No CHANGES.yaml entry — running smoke set only.');
  } else {
    console.error(`[verifier] Changed features: ${changedFeatures.join(', ')}`);
  }

  const manifest: ReleaseManifest = {
    tag,
    version: tag.replace(/^v/, ''),
    platform,
    artifactUrl: localArtifact ?? installerPath,
    artifactFilename: filename,
    changedFeatures,
  };

  const probes = selectProbes(config, changedFeatures);
  if (probes.length === 0) {
    console.error('[verifier] No probes selected — nothing to do.');
    process.exit(0);
  }
  console.error(`[verifier] Selected probes: ${probes.map((p) => p.id).join(', ')}`);

  const installDir = path.join(HERE, 'installs', `${tag}-${platform}`);
  console.error(`[verifier] Installing to ${installDir}…`);
  const installed = await install(installerPath, platform, installDir);

  try {
    console.error(`[verifier] Running ${probes.length} probe(s)…`);
    const results = await runAll(probes, {
      manifest,
      installedAppPath: installed.appPath,
      installerPath,
      reportsDir,
    });

    for (const r of results) {
      const prefix = r.status === 'pass' ? '[ok]' : r.status === 'fail' ? '[FAIL]' : '[skip]';
      const firstLine = r.error ? ` — ${r.error.split('\n')[0]}` : '';
      console.error(`  ${prefix} ${r.id} (${(r.durationMs / 1000).toFixed(1)}s)${firstLine}`);
    }

    const md = formatMarkdown(manifest, env, results);
    const reportPath = path.join(reportsDir, `${tag}-${platform}.md`);
    await writeReportFile(reportPath, md);
    console.error(`[verifier] Report written to ${reportPath}`);

    const failed = results.some((r) => r.status === 'fail');
    process.exit(failed ? 1 : 0);
  } finally {
    await installed.cleanup();
  }
}

main().catch((e) => {
  console.error('[verifier] Fatal:', e);
  process.exit(1);
});
