# AIOS_Desktop_Verifier

Post-release verifier for AIOS Desktop. Watches the public releases repo and runs Playwright-driven probes against every shipped artifact on macOS + Windows.

## What this checks

Per release, on both platforms:

- **Preflight** — `codesign --verify --deep --strict`, `spctl --assess` (Gatekeeper), `xcrun stapler validate` (notarization staple) on macOS; `signtool verify /pa` on Windows
- **smoke-launch-chat** — boots the installed app, dismisses macOS permissions modal, skips onboarding, sends a chat message, asserts a response
- **sentry-init** — confirms `@sentry/electron` initialized correctly in the renderer

Evidence captured per probe: Playwright trace (`npx playwright show-trace trace.zip`), renderer console log, main-process stderr log, screenshot on failure.

## How runs are triggered

| Event | Behavior |
|---|---|
| `everyai-com/AIOS_Desktop` publishes a release | Repo there fires `repository_dispatch` event `aios-release` → this workflow runs |
| Manual rerun | `gh workflow run verify-release.yml --repo everyai-com/AIOS_Desktop_Verifier -f tag=v0.2.X` |

Reports land:
- As a comment on a `Verification: vX.Y.Z` issue in `everyai-com/AIOS_Desktop`
- As workflow artifacts (zip with trace + logs + screenshot)

## Local run

```bash
npm ci
GITHUB_TOKEN=$(gh auth token) npx tsx run-local.ts \
  --tag v0.2.55 --platform darwin \
  --owner everyai-com --repo AIOS_Desktop-releases
```

## Source of truth

This repo is a synced clone of `module-installs/verifier-os-v1/scripts/` from the `AIOS_coding` workspace. Edit there, sync here. See module docs for the design.

## Required secrets

- `AIOS_REPO_TOKEN` — fine-grained PAT with `Contents: read` + `Issues: write` on `everyai-com/AIOS_Desktop`. Used to comment verification reports back on a `Verification:` issue.
