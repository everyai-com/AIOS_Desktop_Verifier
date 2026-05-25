// Verifies the Sentry SDK initialized in the shipped renderer.
// Two assertions:
//   1. window.__sentryReady === true   (set by renderer/src/sentry.ts after init)
//   2. window.__sentryDsn is a non-empty string starting with "https://"
//
// We deliberately do NOT call Sentry.captureMessage from this probe — sending
// real events to the production Sentry project on every CI run would pollute
// the issue list. A separate probe (sentry-event-roundtrip, deferred) would
// gate on AIOS_TEST_MODE + verify via the Sentry events API.

import path from "node:path";
import { closeApp, launchApp, type LaunchedApp } from "../harness/app-driver.js";
import type { Probe } from "../harness/types.js";

export const sentryInit: Probe = {
  id: "sentry-init",
  tags: ["smoke", "sentry"],
  description: "Sentry renderer SDK initialized on app boot",
  timeoutMs: 45_000,

  async run(ctx) {
    let launched: LaunchedApp | undefined;
    try {
      launched = await launchApp(ctx.appPath, ctx.userDataDir, ctx.manifest.platform, ctx.logDir);
      const { page } = launched;

      // The permissions overlay we discovered in v1.1 doesn't block this probe
      // (we don't need to click anything), but it'd interfere if we ever did.
      // No dismissal needed here — we only inspect window globals.

      // Poll up to 15s for window.__sentryReady — give the SDK a moment if it
      // initializes asynchronously (the current implementation is synchronous,
      // but be defensive against future refactors).
      const ok = await page.waitForFunction(
        () => (window as unknown as { __sentryReady?: boolean }).__sentryReady === true,
        undefined,
        { timeout: 15_000 },
      ).then(() => true).catch(() => false);

      if (!ok) {
        throw new Error("window.__sentryReady was not true within 15s of app launch");
      }

      const dsn = await page.evaluate(
        () => (window as unknown as { __sentryDsn?: string }).__sentryDsn ?? null,
      );
      if (typeof dsn !== "string" || !dsn.startsWith("https://")) {
        throw new Error(`window.__sentryDsn invalid: ${JSON.stringify(dsn)}`);
      }
    } catch (e) {
      if (launched) {
        const shotPath = path.join(ctx.logDir, "failure.png");
        await launched.page.screenshot({ path: shotPath, fullPage: true }).catch(() => undefined);
      }
      throw e;
    } finally {
      if (launched) await closeApp(launched, ctx.manifest.platform);
    }
  },
};
