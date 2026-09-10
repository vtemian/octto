// e2e/specs/issue-58-end-session.test.ts
/**
 * Issue #58 regression spec: ending a session must actually end it.
 *
 * On v0.4.0, endSession awaited server.stop() without closeActiveConnections,
 * which never settles while the UI websocket is attached: the end_session tool
 * call hung forever, so the agent run never reached E2E_DONE. The v0.4.0 client
 * also reconnected after "end", which could flip the page back to
 * "Waiting for questions..." (the zombie page from the issue).
 *
 * On v0.4.1 the page must stay on "Session Ended" and the run must complete.
 * The assertions encode the FIXED behavior: this spec is expected to FAIL on v0.4.0.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CdpSession, connect, waitForTarget, waitInPage } from "./cdp";
import {
  cdpPort,
  octtoPort,
  readUntil,
  type StubHandle,
  spawnOpencode,
  startStub,
  writeOpencodeConfig,
} from "./harness";

const PLUGIN_PATH = "/work/dist/index.js";
const SCRIPT = join(import.meta.dir, "..", "scripts", "issue-58-end-session.json");
const QUESTION = "Which cache backend should we use?";
const TAB_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 30_000;
const ZOMBIE_WINDOW_MS = 5_000;
const DONE_TIMEOUT_MS = 60_000;

describe("issue #58: session end must not hang nor leave a zombie page", () => {
  let stub: StubHandle;
  let home: string;
  let page: CdpSession | undefined;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "octto-e2e-home-"));
    stub = await startStub(SCRIPT);
    writeOpencodeConfig(home, [PLUGIN_PATH]);
  });

  afterAll(() => {
    page?.close();
    stub?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it("stays on Session Ended and the agent run completes", async () => {
    const run = spawnOpencode(home, "build", "Ask the user which cache backend we should use, then wrap up.");

    // Reaching this tab proves octto's openBrowser() path worked.
    const target = await waitForTarget(cdpPort(), `http://localhost:${octtoPort()}`, TAB_TIMEOUT_MS);
    page = await connect(target.webSocketDebuggerUrl ?? "");

    await waitInPage(
      page,
      `document.body.innerText.includes(${JSON.stringify(QUESTION)})`,
      "question text",
      RENDER_TIMEOUT_MS,
    );

    const submitted = await page.evaluate<boolean>(`(() => {
      const radio = document.querySelector("input[type=radio]");
      if (!radio) return false;
      radio.click();
      const submit = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().toLowerCase() === "submit");
      if (!submit) return false;
      submit.click();
      return true;
    })()`);
    expect(submitted).toBe(true);

    try {
      await waitInPage(
        page,
        `document.body.innerText.toLowerCase().includes("session ended")`,
        "session ended",
        RENDER_TIMEOUT_MS,
      );
    } catch (error) {
      const debug = await page.evaluate<string>(
        `JSON.stringify({ text: document.body.innerText, ws: typeof ws !== "undefined" ? ws.readyState : "n/a", questions: typeof questions !== "undefined" ? questions.length : "n/a", ended: typeof ended !== "undefined" ? ended : "n/a" })`,
      );
      console.log("[issue-58:end-session] page state at failure:", debug);
      throw error;
    }

    // The v0.4.0 client reconnected 2s after "end"; wait well past that tick so a
    // zombie flip back to "Waiting for questions..." has time to happen.
    await Bun.sleep(ZOMBIE_WINDOW_MS);
    const pageText = (await page.evaluate<string>("document.body.innerText")).toLowerCase();
    console.log("[issue-58:end-session] page text after end:", JSON.stringify(pageText));
    expect(pageText).toContain("session ended");
    expect(pageText).not.toContain("waiting for questions");

    // Server liveness is logged for evidence only: Bun's stop() refuses new
    // connections immediately on both versions, so this cannot distinguish them.
    const serverAlive = await fetch(`http://localhost:${octtoPort()}/`)
      .then((r) => r.ok)
      .catch(() => false);
    console.log("[issue-58:end-session] server accepts new connections after end:", serverAlive);

    // On v0.4.0 the end_session tool call hangs inside server.stop(), so the run
    // never prints E2E_DONE.
    let stdout = "";
    let hung = false;
    try {
      stdout = await readUntil(run, ["E2E_DONE"], DONE_TIMEOUT_MS);
    } catch (error) {
      hung = true;
      console.log("[issue-58:end-session] run never completed:", String(error).slice(-400));
    }
    expect(hung, "end_session hung (pre-#53 teardown bug): the run never printed E2E_DONE").toBe(false);
    expect(stdout).toContain("E2E_DONE");
  }, 180_000);
});
