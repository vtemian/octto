# End-to-end harness

Runs octto inside a real opencode session, in a container, against a real browser.

```bash
bun run test:e2e
```

## What is real, and what is not

Real: the opencode runtime, the octto plugin loaded the way users load it, Chromium
under Xvfb reached through octto's own `xdg-open` call, the session HTTP server, and
the websocket answer round-trip.

Faked: only the model. A scripted OpenAI-compatible provider (`stub-provider/`)
replays a fixed list of tool calls, so a run is deterministic, offline and free.

This split is deliberate. It catches integration breaks (plugin fails to load, browser
never opens, UI stops rendering a field, answers stop reaching the agent) without the
flakiness and cost of a live model.

**It cannot catch prompt-adherence bugs**, where the model simply fails to make the
next call. Issue #7's follow-up bug is exactly that class, which is what the second
tier is for.

## Live tier

```bash
docker run --rm \
  -v "$HOME/.local/share/opencode/auth.json:/auth.json:ro" \
  -e OCTTO_E2E_AUTH_FILE=/auth.json \
  -e OCTTO_E2E_LIVE_MODEL=opencode/deepseek-v4-flash-free \
  octto-e2e
```

The default model is a **free** opencode zen model, so this tier costs nothing. Verified
locally: passes in ~17s. Credentials are copied into the isolated `HOME`, never logged.
Any model works; free ones are less precise about optional arguments, so the spec asserts
follow-through rather than a particular question shape.

Same container, real provider, no script: a real model is asked to run the loop, and
the spec checks it follows through *unprompted* once the answer lands. That is the
only way to catch the #7 class of bug.

Skipped when `OCTTO_E2E_LIVE_MODEL` is unset, so the default suite stays free and
deterministic. In CI it is `workflow_dispatch` only, and exits cleanly rather than
failing when no key is configured.

## Scripts

A script is an ordered list of assistant turns. Turn N answers the request carrying N
prior assistant messages, which keeps the stub stateless across retries.

```json
[
  { "tool": "start_session", "args": { "title": "…", "questions": [ … ] } },
  { "tool": "get_next_answer", "args": { "session_id": { "$extract": "ses_[a-z0-9]+" } } },
  { "text": "E2E_DONE" }
]
```

Session ids are minted at runtime and cannot be hardcoded, so `{"$extract": "<regex>"}`
is replaced by the last match seen anywhere in the conversation so far.

## Notes for future work

- Local plugins load by **absolute path in the `plugin` array**. The documented
  `.opencode/plugins/` directory did not load them.
- opencode has no config-dir env var; isolation is done by overriding `HOME`. Because
  each spec gets its own `HOME`, the default browser association must be system-wide
  (`/etc/xdg/mimeapps.list`), not per-user.
- Chrome is driven over raw CDP. `playwright-core` hangs on the websocket handshake
  under Bun, while a plain `WebSocket` works.
- `xdg-open` must launch Chromium with the **same** `--user-data-dir` as the
  CDP-enabled instance, or it silently starts a second, unobservable browser.
- Unit tests are scoped with `bun test tests`. Bun treats that argument as a substring
  filter, so the e2e specs live in `e2e/specs/` to stay out of the normal gate.
