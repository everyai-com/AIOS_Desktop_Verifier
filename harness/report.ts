// Markdown report renderer + GitHub issue comment poster.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import type { ProbeResult, ReleaseManifest, RunEnvironment } from './types.js';

const STATUS_EMOJI: Record<ProbeResult['status'], string> = {
  pass: '✅',
  fail: '❌',
  skip: '⏭️',
};

export function formatMarkdown(
  manifest: ReleaseManifest,
  env: RunEnvironment,
  results: ProbeResult[],
): string {
  const lines: string[] = [];
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  const headline = failed === 0 ? '✅ All checks passed' : `❌ ${failed} check(s) failed`;

  lines.push(`# Verification report — ${manifest.tag} (${manifest.platform})`);
  lines.push('');
  lines.push(`**Result:** ${headline}`);
  lines.push(`**Artifact:** \`${manifest.artifactFilename}\``);
  lines.push(`**Summary:** ${passed} pass · ${failed} fail · ${skipped} skip`);
  if (manifest.changedFeatures.length > 0) {
    lines.push(`**Changed features:** ${manifest.changedFeatures.map((f) => `\`${f}\``).join(', ')}`);
  }
  lines.push('');
  lines.push('<details><summary>Run environment</summary>');
  lines.push('');
  lines.push(`- Started: \`${env.runStartedAt}\``);
  lines.push(`- Host: \`${env.runnerHost}\``);
  lines.push(`- OS: \`${env.osVersion}\` (${env.arch})`);
  lines.push(`- Node: \`${env.nodeVersion}\``);
  lines.push(`- Playwright: \`${env.playwrightVersion}\``);
  lines.push('');
  lines.push('</details>');
  lines.push('');

  lines.push('| Check | Status | Duration |');
  lines.push('|---|---|---|');
  for (const r of results) {
    lines.push(`| \`${r.id}\` | ${STATUS_EMOJI[r.status]} ${r.status} | ${(r.durationMs / 1000).toFixed(1)}s |`);
  }
  lines.push('');

  // Preflight summary (attached to whichever result carries it — usually a synthetic 'preflight' result)
  for (const r of results) {
    if (r.preflightSummary) {
      lines.push('## Preflight');
      lines.push('');
      lines.push('```');
      lines.push(r.preflightSummary);
      lines.push('```');
      lines.push('');
      break;
    }
  }

  const failures = results.filter((r) => r.status === 'fail');
  if (failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const r of failures) {
      lines.push(`### \`${r.id}\``);
      lines.push('');
      lines.push('**Error:**');
      lines.push('```');
      lines.push(r.error ?? '(no error message)');
      lines.push('```');
      lines.push('');
      const evidence = [
        r.screenshotPath && `- Screenshot: \`${r.screenshotPath}\``,
        r.tracePath && `- Playwright trace: \`${r.tracePath}\` (view: \`npx playwright show-trace ${r.tracePath}\`)`,
        r.consoleLogPath && `- Renderer console: \`${r.consoleLogPath}\``,
        r.stderrLogPath && `- Main stderr: \`${r.stderrLogPath}\``,
      ].filter(Boolean) as string[];
      if (evidence.length > 0) {
        lines.push('**Evidence:**');
        for (const e of evidence) lines.push(e);
        lines.push('');
      }
      if (r.sidecarLogTail) {
        lines.push('<details><summary>Sidecar log tail</summary>');
        lines.push('');
        lines.push('```');
        lines.push(r.sidecarLogTail);
        lines.push('```');
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

export async function writeReportFile(filePath: string, body: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body, 'utf8');
}

// Posts/updates an issue titled `Verification: <tag>` on the target repo and adds the
// report as a new comment. We use an issue (not a release comment) because the
// GitHub API has no first-class release comment endpoint.
export async function postIssueComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string,
  body: string,
): Promise<{ issueNumber: number; commentUrl: string }> {
  const title = `Verification: ${tag}`;
  const search = await octokit.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue in:title "${title}"`,
  });
  let issueNumber: number;
  const existing = search.data.items.find((i) => i.title === title);
  if (existing) {
    issueNumber = existing.number;
  } else {
    const created = await octokit.issues.create({
      owner,
      repo,
      title,
      body: `Auto-generated verification thread for release **${tag}**.\nReports posted below.`,
      labels: ['verification'],
    });
    issueNumber = created.data.number;
  }
  const comment = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return { issueNumber, commentUrl: comment.data.html_url };
}
