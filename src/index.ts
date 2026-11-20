import type { Plugin as PluginV2 } from "@opencode/plugin";
import type { Plugin as PluginV1 } from "@opencode-ai/plugin";

import { server, setup } from "@/host";

/**
 * One default export for both hosts. OpenCode 1 (1.18.29 or newer) calls
 * `server()` and uses the hooks it returns; OpenCode 2 reads `id` and calls
 * `setup()`. Neither host translates the other's API, so each adapter is
 * complete on its own. Never add a `tui` key here: v1 rejects modules that
 * define both `server` and `tui`.
 */
interface OcttoModule {
  readonly id: string;
  /**
   * Typed without v2 types on purpose: `@opencode/plugin` is a dev dependency,
   * so the published declarations must not import it. `definition` below
   * checks the real v2 contract at build time.
   */
  readonly setup: (context: never) => Promise<unknown>;
  readonly server: PluginV1;
}

const definition = {
  id: "octto",
  setup,
  server,
} satisfies PluginV2.Plugin & Pick<OcttoModule, "server">;

const Octto: OcttoModule = definition;

export default Octto;

export type * from "./types";
