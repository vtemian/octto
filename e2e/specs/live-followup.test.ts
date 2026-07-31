// e2e/specs/live-followup.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CdpSession, connect, waitForTarget, waitInPage } from "./cdp";
import { cdpPort, octtoPort, readUntil, spawnOpencode, writeLiveConfig } from "./harness";

const PLUGIN_PATH = "/work/dist/index.js";
const PROMPT = readFileSync(join(import.meta.dir, "..", "scripts", "live-followup.md"), "utf8");
const TAB_TIMEOUT_MS = 90_000;
const RENDER_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 180_000;

const LIVE_MODEL = process.env.OCTTO_E2E_LIVE_MODEL;

/**
 * The scripted tier cannot catch prompt-adherence bugs, because the script
 * decides what the model does. This tier asks a real model to run the loop and
 * checks it actually follows through after the answer lands, which is the
 * failure reported in issue #7.
 *
 * Skipped unless OCTTO_E2E_LIVE_MODEL is set, so the default suite stays free.
 */
describe.skipIf(!LIVE_MODEL)("octto driven by a live model", () => {
  it("should follow through and report the answer after the user responds", async () => {
    const home = mkdtempSync(join(tmpdir(), "octto-e2e-live-"));
    let page: CdpSession | undefined;

    try {
      writeLiveConfig(home, [PLUGIN_PATH], LIVE_MODEL ?? "");
      const run = spawnOpencode(home, "build", PROMPT);

      const target = await waitForTarget(cdpPort(), `http://localhost:${octtoPort()}`, TAB_TIMEOUT_MS);
      page = await connect(target.webSocketDebuggerUrl ?? "");

      // Answer with whatever control the model chose to render: this tier is about
      // follow-through, not about the model picking a particular question option.
      await waitInPage(page, `document.querySelector("input, button")`, "an answerable control", RENDER_TIMEOUT_MS);

      await page.evaluate<boolean>(`(() => {
        const choice = document.querySelector("input[type=radio], input[type=checkbox]");
        if (choice) choice.click();
        const submit = [...document.querySelectorAll("button")].find((b) => /submit|yes|approve/i.test(b.textContent));
        if (submit) submit.click();
        return true;
      })()`);

      // The model must come back to the user unprompted once the answer lands.
      const stdout = await readUntil(run, ["E2E_LIVE_OK"], RUN_TIMEOUT_MS);
      expect(stdout).toContain("E2E_LIVE_OK");
    } finally {
      page?.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
