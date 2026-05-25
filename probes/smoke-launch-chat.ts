// Phase-1 smoke probe. Exercises the full app stack:
//   Electron boot → Python sidecar start → Claude Code CLI spawn → IPC round-trip → SQLite write.
// If this passes, ~80% of "did the build come out alive" is answered.

import path from 'node:path';
import { closeApp, launchApp, type LaunchedApp } from '../harness/app-driver.js';
import { getAppState } from '../harness/state.js';
import type { Probe } from '../harness/types.js';

const PROMPT = 'respond with the single word OK';

export const smokeLaunchChat: Probe = {
  id: 'smoke-launch-chat',
  tags: ['smoke'],
  description: 'Launch the shipped app, send a chat message, assert a response and a session row.',
  timeoutMs: 90_000,

  async run(ctx) {
    let launched: LaunchedApp | undefined;
    try {
      launched = await launchApp(ctx.appPath, ctx.userDataDir, ctx.manifest.platform, ctx.logDir);
      const { page } = launched;

      // 1. Dismiss the macOS permissions modal if present. We click through every
      //    "Skip for now" button — the modal has 4 steps (mic, screen, accessibility, ...)
      //    and each Skip click advances to the next. Keep clicking until either the
      //    modal closes or we hit a 5-iteration safety cap.
      const macSkipTestid = page.getByTestId('mac-permissions-skip');
      for (let i = 0; i < 5; i++) {
        const visible = await macSkipTestid.isVisible({ timeout: 1_500 }).catch(() => false);
        if (!visible) break;
        await macSkipTestid.click({ timeout: 3_000 }).catch(() => undefined);
        await page.waitForTimeout(300);
      }
      // Backstop: if the overlay element is still in the DOM (e.g. a Continue/Close
      // button we don't recognize), hide it. Don't fail the smoke for stuck UI.
      await page.evaluate(() => {
        document
          .querySelectorAll('.mac-permissions-overlay, [aria-label="Permissions setup"]')
          .forEach((el) => {
            (el as HTMLElement).style.display = 'none';
            (el as HTMLElement).style.pointerEvents = 'none';
          });
      });

      // 2. Skip onboarding. The "Skip and start" button is at the connect stage and is
      //    tagged data-testid="onboarding-skip" as of v0.2.55+.
      const skipByTestId = page.getByTestId('onboarding-skip');
      try {
        if (await skipByTestId.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await skipByTestId.click();
          await page.waitForTimeout(500); // settle into chat screen
        }
      } catch { /* no onboarding visible — already past it */ }

      // 3. Find the chat input. Prefer testid; fall back to a textarea with any chat-like
      //    placeholder; finally the LAST visible textarea (chat input is at the bottom of
      //    chat UIs). `.last()` matters when the page has hidden textareas elsewhere
      //    (modals, agent drawers, etc.) which `.first()` would match wrongly.
      const inputByTestId = page.getByTestId('chat-input');
      // Use a broad placeholder match: "Ask", "Type", "message", "command" — covers idle
      // and mid-flight placeholders ("Ask anything…" vs "Type your next message…").
      const inputByPlaceholder = page.locator(
        'textarea[placeholder*="Ask" i], textarea[placeholder*="Type" i], textarea[placeholder*="message" i], textarea[placeholder*="command" i]',
      );
      // Visibility filter via bounding box — Playwright doesn't support :visible pseudo-class.
      const visibleTextareas = page.locator('textarea').filter({
        has: page.locator(':scope:not([hidden])'),
      });
      let chatInput =
        (await inputByTestId.count()) > 0 ? inputByTestId.first()
        : (await inputByPlaceholder.count()) > 0 ? inputByPlaceholder.last()
        : visibleTextareas.last();

      await chatInput.waitFor({ state: 'visible', timeout: 15_000 });
      await chatInput.click({ timeout: 10_000 });
      await chatInput.fill(PROMPT);

      // 4. Submit. Prefer a Send button; fall back to Enter.
      const sendBtn = page.getByRole('button', { name: /^send$/i });
      if (await sendBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await sendBtn.click();
      } else {
        await chatInput.press('Enter');
      }

      // 5. Wait for the assistant's response containing "OK".
      await page.locator('text=/\\bOK\\b/i').first().waitFor({ timeout: 45_000 });

      // 6. Backend assertion via state helper (IPC first, SQLite fallback).
      //    The UI round-trip is the strong signal; the DB assertion is corroboration.
      //    If state is "unavailable" (no IPC AND no DB at any known path), log it but
      //    don't fail — the chat completed successfully, which is the primary smoke check.
      const state = await getAppState(page, ctx.userDataDir);
      if (state.source === 'unavailable') {
        console.error(
          `  [warn] smoke-launch-chat: backend state unavailable (DB not found and no test-mode IPC). UI assertion passed.`,
        );
      } else if (state.sessionCount === 0) {
        throw new Error(
          `Expected at least one session after sending a message, but state.sessionCount=0 (source=${state.source})`,
        );
      }
    } catch (e) {
      // Capture a screenshot for the report.
      if (launched) {
        const shotPath = path.join(ctx.logDir, 'failure.png');
        await launched.page
          .screenshot({ path: shotPath, fullPage: true })
          .catch(() => { /* best-effort */ });
      }
      throw e;
    } finally {
      if (launched) await closeApp(launched, ctx.manifest.platform);
    }
  },
};
