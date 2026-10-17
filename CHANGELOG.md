# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-10-17

### Added
- OpenCode 2 support. The package default-exports `{ id, setup, server }`: OpenCode 2 loads it through `setup()`, OpenCode 1 (1.18.29 or newer) through `server()`.

### Changed
- Default agent model moved from `openai/gpt-5.2-codex`, which both hosts dropped from their catalogues, to `openai/gpt-5.3-codex`. Override it in `octto.json` as before.
- **Breaking:** OpenCode 1 releases older than 1.18.29 are no longer supported; they expect a function default export.
- Tools are defined host-agnostically on zod and the probe agent is called through a `ProbeRunner`, so both hosts share one core.
- `@opencode/plugin` 2.0.31 is a dev dependency for types only; OpenCode 2 supplies the runtime module and the bundle keeps it external.
- A root `index.js` shim re-exports `dist/index.js`: OpenCode 2 resolves directory plugins by that file and ignores `package.json` exports.
- zod is pinned to one copy via `overrides`, so the schemas handed to OpenCode 1 come from 4.3.5 instead of the SDK's nested 4.1.8.

## [0.4.5] - 2026-09-23

### Changed
- `@opencode-ai/plugin` moved from 1.18.30 to 1.18.31 (#62).
- `eslint-plugin-unicorn` moved from 74.0.0 to 76.0.0 (#63).

## [0.4.4] - 2026-09-10

### Security
- Session servers now require a per-session token. The session URL carries a 192-bit CSPRNG token (`?token=…`) that every route requires — the page and the `/ws` upgrade alike — on top of the existing loopback bind and same-origin Host checks. Without the URL, a local process could previously read question configs (which can embed file contents) or submit answers impersonating the user, including approving the plan review (#55).
- Websocket answer payloads are shape-validated against the real `Answer` union instead of an `unknown` cast (#55).
- Rendered markdown now goes through DOMPurify before `innerHTML`, both CDN scripts are SRI-pinned (marked 15.0.12, DOMPurify 3.4.15), the UI falls back to escaped text when either fails to load, and the page is served with a Content-Security-Policy (#55).
- `answer.emoji` is escaped before rendering (#55).

### Fixed
- `createStatePersistence`'s dead default now matches the `.octto` directory used everywhere else (#55).

## [0.4.3] - 2026-09-10

### Fixed
- Deleting the opencode session mid-brainstorm now tears the brainstorm's session server down. `create_brainstorm` creates its browser session internally, and the `session.deleted` cleanup only tracked `start_session` output, so the leaked server kept serving its stale "waiting for questions" page and, on a pinned port, blocked the next brainstorm from binding (#58).
- E2E specs no longer contaminate each other: closing a CDP session now closes the chromium tab too, instead of leaving a stale page the next spec's `waitForTarget` could latch onto, and a spec failing before its run completes still kills the opencode process in `afterAll` instead of leaking the pinned port (#58).

## [0.4.2] - 2026-09-10

### Added
- End-to-end regression specs for issue #58: session end must not hang nor leave a zombie page, and deleting an opencode session mid-brainstorm must not leak the session server.

### Changed
- `@opencode-ai/plugin` moved from 1.18.15 to 1.18.29 (#59).
- `eslint-plugin-unicorn` moved from 73.0.0 to 74.0.0 (#60).

## [0.4.1] - 2026-09-03

### Fixed
- Session teardown no longer hangs. `endSession` awaited `server.stop()` without closing active connections, which never settles while a websocket is attached, so `end_brainstorm`, `end_session` and the `session.deleted` handler all hung until the user closed the tab. The UI now closes its socket on end and skips the reconnect (#53).
- Brainstorm livelock is closed on both routes in. A branch could sit EXPLORING with no pending question, turning `await_brainstorm_complete` into a non-terminating loop that reported collecting answers it never received. A probe result with no question now completes the branch, unparseable probe output returns the fallback instead of throwing, and the wait loop stops when nothing is pending and nothing is in flight (#53).

### Security
- The session server no longer binds the wildcard address. It now binds 127.0.0.1 and requires a same-origin loopback Host, which blocks access from the local network and from other browser tabs (websockets ignore same-origin policy), including the DNS rebinding bypass that an origin check alone permits. Clients sending no Origin are still accepted by design (#53).

### Changed
- `@opencode-ai/plugin` moved from 1.18.9 to 1.18.15 (#54, #56).
- `eslint-plugin-unicorn` moved from 72.0.0 to 73.0.0 (#57).

## [0.4.0] - 2026-07-31

### Changed
- **Breaking:** `OcttoTool.execute` now returns `Promise<ToolResult>` instead of `Promise<string>`. The plugin SDK widened the type to a union of a string and a structured `{ title?, output, metadata?, attachments? }` result. Tool implementations may still return a plain string; code that consumes an execute result must narrow it, for which `outputText` is exported.
- **Breaking:** `@opencode-ai/plugin` moved from 1.0.223 to 1.18.9.

### Added
- Top-level `model` key in `octto.json` overrides the model for every agent at once. Per-agent entries still win where set (#17).
- `outputText` normalizes either `ToolResult` shape to its text.
- End-to-end test harness running octto inside a real opencode session, with a real browser, in a container.

### Fixed
- `allowOther` now renders a freetext choice. The flag was accepted by four schemas and described to the model, but no renderer ever read it, so it was a no-op (#7, #48).
- Question config properties are no longer stripped by Zod on the `start_session` and `push_question` paths, which had left `pick_one`, `pick_many`, `rank` and `rate` with empty option lists (#6, #28).
- Octto no longer leaks its agent objects into the resolved config. A shallow copy let another plugin's in-place mutation reach octto's stored state and persist across resolutions, and let injected prompt fragments stack on every re-instantiation (#51).
- `create_brainstorm` no longer tells the agent to run its own `get_next_answer` loop, which the agent prompt forbids and which records no findings into branch state. An unfinished brainstorm now reports why it stopped (#49).

## [0.1.0] - 2025-01-06

### Added
- Branch-based brainstorming with parallel exploration
- Browser UI for answering questions
- Event-driven answer processing with `await_brainstorm_complete`
- Inline probe logic for automatic follow-up question generation
- User-configurable agent settings via `~/.config/opencode/octto.json`
- Question types: `pick_one`, `pick_many`, `confirm`, `ask_text`, `rank`, `rate`, `slider`, `thumbs`, `show_plan`, `show_options`, `show_diff`, `review_section`
- Dual session system (state persistence + browser WebSocket)
- Design document output to `docs/plans/`

### Security
- Input validation for all question configs (empty options, bounds checking)
- Whitelisted agent config overrides (only model, temperature, maxSteps)
- Session ID path traversal protection
