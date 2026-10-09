# Patch changelog

History of how the `@earendil-works/pi-*` patches in this directory changed across
upgrades. **Patch headers describe the patch as it is today; this file records how it
got there.**

Why the split: patch headers answer three questions a reader always needs — what the
patch does (`Changes:`), where the issue lives (`Tracking:`), and when it can be
deleted (`Removal:`). Rebase narrative is none of those. It expires, it duplicates
git, and left in the header it grows without bound.

**Adding an entry:** on every PI upgrade, add a section for the new version describing
per-package rebase decisions, anything deliberately dropped or retained, and traps the
next rebaser must avoid. Keep patch headers to the three durable fields.

---

## @modelcontextprotocol/client@2.0.0 (mid-version, additive) — OAuth Accept headers

Not an upgrade: a new patch for the v2 client package while the pin stayed put.
This is the package that performs the harness's MCP OAuth flows at runtime (a
pi-mcp-adapter dependency), verified by the spec-strict gateway e2e
(`tests/e2e/tui/mcp-oauth-strict-accept.test.ts`, fixture `strictAccept` mode
answering 406 without `text/event-stream`): with this patch the strict-gateway
login completes; on master it fails with HTTP 406 on the metadata/DCR
endpoints. The sdk 1.29.0 patch below covers entry points that still import
the legacy 1.x package; the harness's own MCP OAuth path uses this one.

### `@modelcontextprotocol/client` (new patch)

- **NEW — `dist/index.{mjs,cjs}`.** `tryMetadataDiscovery` (protected-resource
  metadata, previously no Accept header), `discoverAuthorizationServerMetadata`
  (was json-only), and `registerClient` / DCR (previously no Accept header) now
  send `Accept: application/json, text/event-stream`. The token POST
  (`executeTokenRequest`) is deliberately unchanged, matching the sdk patch's
  residual-risk note.

---

## pi-mcp-adapter@2.34.0 / @modelcontextprotocol/sdk@1.29.0 (mid-version, additive) — OAuth Accept headers + DCR version

Not an upgrade: new hunks added to the adapter patch and a new SDK patch while both
pins stayed put. Rebasers can ignore this section; it exists only to explain where
the OAuth hunks came from.

### `pi-mcp-adapter`

- **NEW — `mcp-oauth-provider.ts`: Accept header on configured-discovery metadata
  fetch.** Now sends `application/json, text/event-stream` (was json-only);
  spec-strict gateways (agentgateway) answer 406 otherwise.
- **NEW — `mcp-auth-flow.ts`: DCR clientInfo version.** Bumped stale hardcoded
  `"2.11.0"` to `"2.34.0"` so registered OAuth clients report the real package
  version (the stale string caused a misdiagnosed incident report).

### `@modelcontextprotocol/sdk` (new patch)

- **NEW — `dist/{esm,cjs}/client/auth.js`.** `discoverAuthorizationServerMetadata`
  GET and `registerClient` (DCR) POST now send `Accept: application/json,
  text/event-stream` (DCR previously sent no Accept header). The token POST
  (`executeTokenRequest`) is deliberately unchanged — it is a plain JSON endpoint
  and worked in the affected environment. Trap for rebasers: patch both the esm
  and cjs mirrors; line numbers differ between them.

---

## 0.85.1 (mid-version, additive) — configurable wheel-scroll speed

Not an upgrade: a new behavior was added to the pi-tui patch while the pin stayed
at 0.85.1. Rebasers can ignore this section entirely; it exists only to explain
where the `tui-alt-screen.js` hunk came from.

### `@earendil-works/pi-tui`

- **NEW — `tui-alt-screen.js`: `KIMCHI_WHEEL_SCROLL_LINES` env fallback.** The
  constructor previously hardcoded `options.wheelScrollLines ?? 1`. The patch
  inserts module-level `kimchiWheelScrollLines()` (parseInt; `Number.isFinite`
  guard; returns `undefined` for absent/invalid) and threads it as the middle
  fallback: explicit option > env > upstream default `1`. Kimchi maps its
  `tui.wheelScrollLines` config onto the env var in `src/cli.ts` at startup, so
  this is the only channel needed — no pi-coding-agent wiring. Explicit-option
  precedence is deliberate: if upstream later adds a `wheelScrollLines` setting
  (7+ open issues; all community PRs auto-closed), the construction site wins
  over the env var and the patch reduces to the `?? 1` removal.
  The bundle copy in pi-coding-agent's `dist/bundle/chunks/` has the same code
  inlined but is only reachable via the standalone `pi` bin — Kimchi runs the
  unbundled modules, so one hunk covers the whole harness.

---

## 0.84.1 → 0.85.1

### `@earendil-works/pi-ai`

- **`validateToolArguments` — preserved upstream's new `normalizeOptionalNulls()`.**
  Upstream added it in 0.85.1, called on the raw clone before conversion. Kimchi's
  patch rewrites the same opening, so the rebase had to *layer* onto it rather than
  replace it. A rebase that drops the call installs cleanly, typechecks cleanly, and
  silently regresses optional-null handling on every tool call.
  **Order matters:** `normalizeOptionalNulls` mutates in place and only understands
  real objects/arrays, so it must run before Kimchi's coercion reparses stringified
  arguments into new references.
- `parseChunkUsage` — context drift only. Upstream expanded `cacheReadTokens` (added
  `rawUsage.cached_tokens` for Kimi) and rewrote the comment block; the
  `cacheWriteTokens` line Kimchi changes was untouched.

### `@earendil-works/pi-tui`

- **`text.js` — layered on upstream's new `paddingX` clamp.** 0.85.1 clamps
  `paddingX = min(this.paddingX, floor((width-1)/2))`. The clamp is kept; Kimchi's
  stroke accounting and hard truncation sit on top, and the *clamped local*
  `paddingX` is threaded through both `applyStrokeToLine` call sites, including the
  empty-line path. Upstream clamped only `Text` — `Box` and `Markdown` still need
  Kimchi's hardening (upstream gap, worth reporting).
- **`tui-main-screen.js` — hunk rewritten.** The clear sequence moved into the new
  `BoundedTerminalWriter`; the `PI_TUI_NO_CLEAR_SCROLLBACK` gate was rewritten from
  `buffer +=` to `output.append(...)`. Guaranteed failure on rebase — the old idiom
  no longer exists.
- **`box.js` — extended upstream's new `handleMouse()`.** 0.85.1 added mouse support.
  Upstream is self-consistent (`handleMouse` and `render` both use
  `width - paddingX*2`), but Kimchi's stroke patch changes `render()` to subtract
  `STROKE_WIDTH` — so without extending `handleMouse` too, hit-testing drifts 2 cells
  from what is drawn. This is not an upstream bug and not an upstream candidate; it
  exists only because of Kimchi's stroke. Verify by clicking inside tool blocks.
  Only reachable in fullscreen mode (`tuiMode: "fullscreen"`, non-default) — the
  mouse enable sequences live solely in `tui-alt-screen.js`.

### `@earendil-works/pi-coding-agent`

- **NEW — `{ persist }` on the extension `setModel`.**
  0.85.1 made `AgentSession.setModel()` persistence opt-in (`options.persist`,
  default `false`), while the extension-facing wrapper stayed byte-identical — so
  every `pi.setModel()` call kept typechecking and silently stopped writing the
  user's default. Kimchi threads options through three points (extension action in
  `agent-session.js`, the `loader.js` runtime facade, and `types.d.ts`) to restore
  the 0.84.1 channel. `runner.js` needs no change: it assigns the action by
  reference rather than rewrapping it.
  **`setThinkingLevel` is deliberately NOT threaded**, though upstream gave it the
  same `ModelMutationOptions` parameter. Kimchi's only caller is
  `src/extensions/tags.ts` (`set_phase`), which is tool-driven, not user-initiated,
  and must stay session-only — so the plumbing would ship with no caller. Pi's own
  `/thinking` and `/settings` reach the class method directly and are unaffected.
  *Upstream candidate — "let extensions opt into persistence" is generic. Worth
  asking for both signatures there, for symmetry, even though Kimchi only needs
  `setModel` today.*
- **DROPPED — a stray `sessionId` argument on `showLoginProviderSelector`.**
  The `sessionId` injection belongs to `showModelSelector`, which declares
  `const sessionId = this.sessionManager.getSessionId()` in scope. Upstream's
  0.85.1 refactor shifted line numbers and a second copy of the hunk landed in
  `showLoginProviderSelector(authType, initialSearchInput)`, which has no such
  binding — making `sessionId` a free variable that throws
  `ReferenceError: sessionId is not defined` whenever that selector renders.
  It typechecks and every unit test passes, because the login tests stub the
  selector and Kimchi's own `/login` menu (`src/login-command-patch.ts`) never
  routes through it. The reachable path is `/login <prefix>` where the prefix
  matches two providers with *different* ids: `patchedHandleLoginCommand`
  delegates to upstream, which falls through to the broken selector.
  `OAuthSelectorComponent` takes five parameters, so the argument was inert
  even had the variable existed — the hunk is deleted outright, not repaired.
  **Lesson: when a rebase relocates a hunk, verify the *enclosing function*,
  not just that the context lines still match. Identical trailing context
  (`}, initialSearchInput);`) appears in more than one selector method.**
- **Model selector rebuilt on the 0.85.1 constructor.** `settingsManager` was removed
  and `onSelectAsDefault`/`defaultModel` added, colliding with the position Kimchi
  used for `sessionId`. `sessionId` moved to the last positional parameter;
  `handleSelect` keeps `__kimchi*` tracking but no longer calls the removed
  `setDefaultModelAndProvider`; persistence now flows through interactive-mode's
  `selectModel(model, persist)` closure.
- **Edit-rendering hunks retargeted** from `core/tools/edit.js` to the new
  `core/tools/renderers/edit.js` — upstream extracted renderers, bodies moved
  unchanged. Five sibling renderer modules are also new; none calls `theme.bg(...)`,
  so the foreground-only treatment did not need extending.
- **RETAINED — the `exportToJsonl` `await` hunk.** Upstream's method is synchronous in
  both versions, which makes the hunk *look* like dead code. It is not:
  `src/cli.ts:239` monkey-patches the prototype with an async wrapper (trace-ID
  injection + awaited PII redaction, fail-closed). The hunk is the paired second half
  of that contract — dropping it prints `[object Promise]` and returns before
  redaction completes, a security regression. It was dropped during the rebase, then
  restored in `6f66b1fd` after live verification.
  **Lesson: read every hunk against Kimchi's runtime monkey-patches, not just the
  upstream tarball.**
- **DROPPED — the `pasteToEditor` routing hunk.** Two layers patched the same
  property: this hunk (`ui.handleInput`) and `src/paste-to-editor-patch.ts`
  (`ui.handleTerminalInput`). The TS wrapper always won at runtime, making the hunk
  invisible dead configuration. The TS patch is now the single home — it is visible
  source and covered by `paste-to-editor-patch.test.ts`.
- **`tools/bash.js` timeout pipe-cleanup now lives in `createLocalShellOperations()`**,
  so it also covers the new PowerShell tool. Intentional scope widening.
- **Bun `Type2` Proxy re-applied** after upstream's bundled-runtime restructure (new
  `isBundledNode` import, Node SEA detection). Only observable in the compiled
  binary — verify by loading a third-party npm extension from `dist/bin/kimchi`.

### Kimchi-side follow-ups from this upgrade

- `src/extensions/router/index.ts` — the session_start CLI-recording path
  (`pi.setModel(ctx.model)`) relied on upstream's unconditional persistence at
  0.84.1. At 0.85.1 the same call became session-only with no signature change, so
  `--model` launches stopped writing `settings.defaultProvider/defaultModel`.
  Same root cause as the `{ persist }` change above. The site was easy to miss when
  auditing call sites: it reads as an internal restore path, but it is recording an
  explicit `--model` flag, i.e. user intent arriving indirectly. Fixed with
  `{ persist: true }` in `31d26aa3`.
  **Caught by pre-existing e2e assertions** (`tests/e2e/tui/auto-model.test.ts:194-196`
  and `:479-481`, which read settings.json directly) — the tests were untouched by the
  fix; only the upstream behavior underneath them changed. TUI e2e runs on every PR
  (`.github/workflows/tui-e2e.yml`), so this would have blocked the merge.
- PR [earendil-works/pi#8627](https://github.com/earendil-works/pi/pull/8627)
  (`ctx.cwd` for the seven cwd-sensitive tools) is a Kimchi-contributed fix that
  **arrives with this upgrade** — absent at 0.84.1, present in all seven at 0.85.1.
  Closes LLM-3185 with no local change, after [kimchi#1099](https://github.com/getkimchi/kimchi/pull/1099) was closed unmerged.
