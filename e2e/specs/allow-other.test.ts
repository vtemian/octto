// e2e/tests/allow-other.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CdpSession, connect, waitForTarget, waitInPage } from "./cdp";
import {
  cdpPort,
  collectRun,
  octtoPort,
  type StubHandle,
  spawnOpencode,
  startStub,
  writeOpencodeConfig,
} from "./harness";

const PLUGIN_PATH = "/work/dist/index.js";
const SCRIPT = join(import.meta.dir, "..", "scripts", "allow-other.json");
const FREETEXT = "SQLite with Litestream";
const TAB_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 30_000;

describe("octto inside a real opencode session", () => {
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

  it("should open a real browser and round-trip an allowOther freetext answer back to the agent", async () => {
    const run = spawnOpencode(home, "build", "Ask the user which datastore we should use.");

    // Reaching this tab proves octto's openBrowser() -> xdg-open path worked,
    // not merely that its HTTP server was listening.
    const target = await waitForTarget(cdpPort(), `http://localhost:${octtoPort()}`, TAB_TIMEOUT_MS);
    page = await connect(target.webSocketDebuggerUrl ?? "");

    await waitInPage(
      page,
      `document.body.innerText.includes("Which datastore should we use?")`,
      "question text",
      RENDER_TIMEOUT_MS,
    );

    // The freetext field exists only once the UI actually honours allowOther.
    await waitInPage(page, `document.querySelector("[id^='other_']")`, "other freetext field", RENDER_TIMEOUT_MS);

    const submitted = await page.evaluate<boolean>(`(() => {
      const input = document.querySelector("[id^='other_']");
      if (!input) return false;
      input.focus();
      input.value = ${JSON.stringify(FREETEXT)};
      const submit = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().toLowerCase() === "submit");
      if (!submit) return false;
      submit.click();
      return true;
    })()`);

    expect(submitted).toBe(true);

    const { stdout, exitCode } = await collectRun(run);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(FREETEXT);
    expect(stdout).toContain("E2E_DONE");
  }, 180_000);
});
