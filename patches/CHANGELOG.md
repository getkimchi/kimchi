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

## 1.3.0 — rebase from 0.85.1 (transcript “worlds” redesign)

The new core reworked the session subsystem: system messages now carry prompts and tool
declarations (`TranscriptContext`), `before_agent_start` is a discriminated union
fired for extension-triggered runs too, tool availability rides
`SystemMessage.toolsAdded`/`toolsRemoved` (in-band `addedToolNames` is gone), and
`session.abort()` is terminal for the run chain (the steer/followUp queues survive
but are only drained by the next fresh run).

### `@earendil-works/pi-coding-agent`

- **PORTED + EXTENDED (2026-10-21, post-rebase) — compaction-history display now
  also covers pi 1.3's event-driven `entry_appended` compaction redraw.** 1.3
  added a streaming compaction event that renders via `buildContextEntries()`
  independently of the legacy `compaction_end` handler the patch had covered;
  the new site now prefers `buildDisplayEntries()` via the same capability
  probe. Detected by the `memd1` TUI e2e (pre-compaction history vanished
  from the transcript under fullscreen alt-screen).

- **NEW — context-overflow recovery id fallback (`_findPersistedMessageEntryId`).**
  0.85.1 removed the failed overflow assistant by slicing it from
  `agent.state.messages` before compacting; the new core replaced that with an
  identity-keyed context edit (`_omitRecoveryAttempt`). In the bun-compiled
  binary the failed message object is materialized through a copy, so object
  identity misses on all upstream paths (id map, branch scan, live-state
  projection index — the failed message never re-enters `agent.state.messages`,
  so the `messageIndex < 0` early return fires first), `_omitRecoveryAttempt`
  silently skips the edit, the post-compaction projection keeps the failed
  assistant at the tail, and `agent.continue()` throws "Cannot continue from
  message role: assistant". The patch adds a role+timestamp fallback match
  against the branch ahead of the messageIndex early return. Detected by the
  `tests/e2e/tui/context-overflow-recovery.test.ts` TUI e2e; verified on the
  compiled binary.
- **NEW — bug-report kimchi destination seams (interactive bug-report.js).**
  Upstream now ships a hardcoded builtin `/bug` that shadowed Kimchi's own report
  extension (removed in the same change — the tip now points at `/bug`). The
  patch adds two global hook seams: `__kimchiBugReportScrub` deep-redacts
  every bundle string before upload *or* zip export (PII/secrets, sharing our
  `pii-redaction` engine), and `__kimchiBugReportDeliver` routes delivery to
  the getkimchi GitHub issue form (private gist of the scrubbed metadata +
  transcript) instead of the built-in Radius upload. Both hooks are provided
  by `src/extensions/bug-report.ts`; with no hook registered the
  stock Earendil flow runs unchanged (the kimchi branding/disclaimer text is
  conditional on the hook being present). The disclaimer/menu copy states
  that a private-gist upload (via the user's own `gh` account) happens only
  when the user opts to include a transcript. Tracking: none — the
  scrubbers, the gist/issue delivery, and the kimchi branding are a
  kimchi-specific feature, so no upstream issue applies. Removal criterion:
  upstream exposes scrub and destination seams natively (then the patch is
  reduced to thin adapters instead of a fork of the flow).
- **DROPPED — triggerTurn `before_agent_start` mirror + `_systemPromptOverride`
  preservation hunks.** Native in 1.2: `_startRun({ messageType: "custom" })` fires
  `emitBeforeAgentStart`, and extension `systemPrompt` results become a
  `forceSystemPrompt` per-request projection that tool-loadout rebuilds never
  touch. Witness coverage rewrote: `src/upstream-system-prompt-preservation-patch.test.ts`
  now pins the native behavior instead of the patch markers.
- **DROPPED — user-message Box wrapper hunk.** Upstream 1.2 renders the Markdown
  child directly; the Kimchi prefix/OSC 133 patch moved extension-side to
  neutralize the Markdown instance's `paddingY`/`paddingX`/`defaultTextStyle`
  (`patchUserMessageRender` in `src/extensions/tool-rendering.ts`).
- **DROPPED — the leftover `contentBox;` field declaration on
  `user-message.js`** (2026-10-15). Vestigial after the wrapper removal — its
  only reader was a guarded pre-1.2 fallback in `patchUserMessageRender`, now
  also removed.
- **MOVED — Bun `type2`/`bundledPiAiCompatSafe` Proxy compat.** Upstream split the
  virtual-module seam: the hunk now lives in `dist/core/extensions/virtual-modules.js`
  instead of `loader.js`.
- **REBASED — force-compaction `keepRecentTokens: 0` retry, session-manager
  `_kimchiOriginalToolContent`/`_serializableEntry`, model-resolver
  `kimchi-dev: minimax-m3`, `setModel { persist }`, bash abort/timeout pipe
  cleanup (`terminateGroup`), interactive-mode/project-trust markers.** Same
  intent, re-homed on the 1.2 functions (several private methods were
  renamed/split by the transcript redesign).
- **NOTED — abort semantics changed silently.** 0.85 chained a continuation
  after a programmatic abort to drain retained queues; 1.2 does not (queues
  drain on the next run). Kimchi's bash-background contract tests now drive
  recovery with a fresh prompt instead of asserting the auto-drain.
- **PORTED (2026-10-15, post-rebase) — auth-storage hunk re-shaped to the
  master-era root fix.** Master's `fix(auth)` (#1425) reworked the 0.85.1
  lock-free-reads hunk after this branch's initial 1.2 rebase: the hunk now
  returns the bare credential map (upstream `readLatestData` unwrap shape
  restored — the `{ result }` wrapper was our own leak), retries torn reads
  with backoff, and treats a 0-byte `content === ""` read as a tear. Same
  code applied verbatim to the current patch; `src/pi-auth*` tests 18/18.

### `@earendil-works/pi-tui`

- **NEW (2026-10-22) — selection soft-wrap glue tracking.** Fullscreen partial
  selections pasted the terminal's hard wrap: `getActiveSelectionText` rebuilt
  text from rendered rows joined with `"\n"`. Rendered rows alone cannot
  distinguish a soft wrap from a hard newline, so `wrapTextWithAnsi` now
  records, per continuation line, the whitespace the wrap consumed (`""` for
  mid-word breaks, clamped to 16 chars); Text/Markdown (and quote/list
  prefixes) publish every padded line with the carried glue (`null` for hard
  starts) plus the component's structural left margin — passed verbatim
  through containers and scroll views — and the alt-screen rejoins marked rows
  with the recorded glue (dropping only the recorded margin, so genuine code
  indentation survives) instead of `"\n"`. The tracking Map must be
  value-keyed (string primitives cannot be WeakMap keys — that variant
  crashed the TUI at startup), so collisions are handled by construction: any
  value seen with conflicting marks turns "ambiguous" and falls back to the
  upstream `"\n"` join, never deleting a real newline. Covered by
  `tests/e2e/tui/copy-message.test.ts` (120-col and 48-col geometry, byte-exact
  reconstruction including mid-word breaks and mid-wrap selection starts).
- **REBASED — stroke rendering (applyStrokeToLine), no-truncate width
  hardening.** The new TUI replaced the
  editor's caret with an APC cursor marker (`\x1b_pi:c\x07` /
  FAKE_CURSOR_START/END); the strip sites in Kimchi source were adapted
  (`\x1b[7m` strokes are now no-ops there).
- **DROPPED — scrollback opt-out (`PI_TUI_NO_CLEAR_SCROLLBACK`)** (2026-10-15).
  `ESC[3J` scrollback clearing is back to upstream's unconditional behavior on
  full renders; `dist/tui-main-screen.js` is no longer patched and
  `tests/unit/pi-tui-scrollback-flag.test.ts` was deleted with it (mirrors the
  same removal made at the 0.85.1 pin on `chore/remove-pi-tui-scrollback-flag`).
- **DROPPED — wheel-scroll speed (`KIMCHI_WHEEL_SCROLL_LINES`)** (2026-10-15).
  Upstream now ships a native velocity-based `WheelScrollAccelerator` with an
  `"auto"` default and a first-class `fullscreenWheelScrollLines` setting; pi
  always passes an explicit value, so the env fallback was unreachable. Kimchi's
  `tui.wheelScrollLines` config now syncs into pi's settings.json key
  (`syncWheelScrollToPiSettings` in `src/config.ts`).
  `applyStrokeToLine` gained a hard truncate so narrow widths can no longer
  overflow (fuzz invariant now enforced against line construction).

### `@earendil-works/pi-ai`

- **LAYERED — `validateToolArguments` coercion/verbose-conversion hunk now sits on
  top of upstream's new `argumentsError` guard** (malformed tool-call arguments now
  fail validation before `structuredClone`; upstream #10897). The Kimchi hunks
  (unconditional `coerceWithJsonSchema` pre-conversion, `Value.Convert` wrapped in
  descriptive try/catch, no `TYPEBOX_KIND` bypass) are unchanged.
- **No hunks applied.** The 0.85.1 oauth-page HTML replacement moved path
  (`dist/auth/oauth/oauth-page.js` → `dist/utils/oauth-page.js`) and stays a
  post-install script (`scripts/patch-pi-ai-oauth.js`), not a pnpm patch.

### `pi-mcp-adapter`

- **BUMPED — 2.34.0 → 5.3.1** (MCP client 2.0.0 → 2.3.1 for GHSA-6qxp-vccf-f47h).
- **DROPPED — `@modelcontextprotocol/sdk@1.29.0` patch.** Adapter 5.3.0's OAuth
  path imports `@modelcontextprotocol/client` 2.3.1 exclusively; sdk 1.29
  remains in the graph only as a peer of `@google/genai`/`mem0ai`/`ext-apps`
  with no `client/auth.js` consumer.
  The client 2.3.1 patch carries the spec-strict-gateway Accept fix alone.
- **DROPPED — tool-annotation caching hunk.** Native in 5.x (metadata-cache
  persists/reconstructs annotations).
- **NEW — bundled-runtime-safe version read (pi-builtin-mcp.ts).** Under Bun
  SEA bundles `import.meta.url` is a $bunfs path with no real package.json;
  the top-level readFileSync threw at import time, so pi's built-in MCP was
  never disabled in compiled binaries and both MCP stacks ran (double tool
  registration and strict-auth-schema warnings). Falls back to "unknown",
  which simply re-checks on each start. Found via CI TUI e2e failures that
  only reproduce against `dist/bin/kimchi`, not dev-mode runs.
- **NEW — always register `/mcp` (index.ts).** Upstream ships a built-in native
  MCP extension (`replaceable`) that reads the same mcp.json files with a
  stricter schema (`auth` must be `{provider}` bearer-name, not the adapter's
  `"oauth"` shorthand) and connects the same servers. Registering `/mcp`
  unconditionally makes pi's loader omit the built-in (upstream-designed
  replacement), so the adapter stays the single MCP owner; verified the
  "MCP servers need attention" banner no longer appears on launch with
  adapter-format configs under a temp HOME.
- **RE-DRAFTED — tool-name sanitization** around upstream's new `formatToolName`
  prefix-dedup branch; truncation wrapped in `truncateToolName()`.
- **RE-DRAFTED — config discovery under Kimchi dirs.** Project/global adapter
  configs moved to `mcp-adapter.json` upstream with `mcp.json` demoted to a
  Pi-compat import tier. The Kimchi patch repoints the compat layers at the
  Kimchi agent/project directories and makes those layers authoritative again
  (2.34 semantics): adapter-format parsing (top-level `settings`/`imports`
  survive — Pi-style compat parsing would drop them), self-writing, and
  project entries merge field-wise over the global entry instead of Pi's
  whole-entry replacement. `writeProjectServerDisabledOverride` writes via
  server provenance so overrides land in the file the server came from.
- **KEPT — OAuth loopback/tombstone/in-flight hunks, metadata Accept widen,
  `mcp.panel`, watcher instructions; DCR clientInfo bumped to "5.3.1".**
- **PORTED — output-guard default 50 KB → 12 KB (`mcp-output-guard.ts`).**
  Carried over from master's 2.34 patch: five parallel ~50 KB MCP results
  (~64k tokens) overflowed 256k-context headroom and killed sessions
  (284,070 of 262,144 tokens). Remove when upstream sizes the guard to
  remaining context (window − reserve − usage); users can override via
  `settings.outputGuard.maxBytes`.
- **NEW — `KIMCHI_MANAGES_MCP_PROJECT_TRUST` hunk.** 5.x interactively prompts
  per project server on trust; the env flag skips that approval so Kimchi's
  existing `resolveMcpProjectTrust` stays the single gate (no double prompt).
- **RE-DRAFTED (5.3.1) — MCP UI capability strip.** 5.3.1 gained an `openUi:
  false` opt-out per server, but still advertises the `io.modelcontextprotocol/ui`
  extension by default; the Kimchi strip now removes only that default-advertise,
  keeping the layout (comment documents it as the host-side disable).
- **CLIENT PATCH (`@modelcontextprotocol/client@2.3.1`) RE-DONE — OAuth
  metadata Accept widen still needed** (2.3.1 still sends json-only at the
  three sites).
- **mcpScript stays OFF** (upstream 4.0 default; Kimchi already pinned
  `scriptMode: false` and suppresses the gateway).

---

## 0.85.1 (mid-version, additive) — bounded abort/timeout pipe cleanup

Not an upgrade: a new behavior was added to the pi-coding-agent patch while the
pin stayed at 0.85.1. Rebasers can ignore this section entirely; it exists only
to explain where the reworked `tools/bash.js` hunk came from (the timeout-only
pipe-cleanup hunk grew into the shared termination helper).

### `@earendil-works/pi-coding-agent`

- **REWORKED — `tools/bash.js`: abort now shares the timeout's bounded pipe
  cleanup.** Previously only the timeout path destroyed the inherited
  stdout/stderr pipe ends (after a 500 ms grace); abort only killed the
  process group. A detached descendant that escaped that group kill
  (`setsid`) and kept writing through the inherited pipes re-armed
  `waitForChildProcess`'s idle timer on every chunk, so an aborted execution
  stayed pending until the descendant's own exit — Managed Stop, safety
  expiry, pre-handoff cancellation, and shutdown all hung the same way.
  Both paths now route through one `terminateGroup()` helper: kill the
  command group, then destroy the pipe ends after 500 ms. The cleanup timer
  is scheduled at most once when abort and timeout overlap and is cleared
  in `finally` when the executor settles first; abort/timeout error messages
  and precedence and the already-aborted handling are unchanged, and normal
  completion keeps the idle-drain behavior (post-exit descendant output
  within the grace) intact.
  **Escaped descendants are NOT terminated by this** — the patch bounds pipe
  cleanup after cancellation of the original command group only.
- Tracking: [earendil-works/pi#10929](https://github.com/earendil-works/pi/issues/10929)
  (upstream issue with a minimal reproduction of the never-settling abort and
  the proposed shared termination; an upstream PR submitting the equivalent
  source change and regression tests is planned against it).
- Validation: `src/extensions/bash-background/bash-cancellation-settlement.test.ts`
  covers the executor directly (escaped stdout and stderr writers, the timeout
  baseline that passes with and without the abort half, abort/timeout overlap
  in both directions, a pre-aborted signal, normal-completion output
  preservation, ordinary tree termination, and cleanup-timer clearing);
  `bash-control-stress.test.ts` keeps the managed-path view — the four
  settlement regressions pass, while escaped-descendant *termination* stays
  pinned as expected failure with explicit teardown.
- Removal: delete the hunk when the pinned Pi release ships equivalent bounded
  abort cleanup (upstream: pi#10929) and keep the Kimchi regression tests.
## @earendil-works/pi-coding-agent@0.85.1 (mid-version, corrective) — lock-free read heals the 0-byte truncate window

Follow-up to the torn-read retry entry above. The retry only engaged when
`JSON.parse` threw; `parseStorageData()` maps empty content to `{}` WITHOUT
throwing, so a read that sampled a non-atomic writer's `open(O_TRUNC)`
window (auth.json at 0 bytes, before the first write lands) silently resolved
"no credentials" and skipped the retry. With the credential gone, request
uuid auth fell back to models.json's `$KIMCHI_API_KEY` template and
hard-failed ("API key auth failed for provider … from environment variable:
KIMCHI_API_KEY") — the exact symptom the `auth-reload-race` TUI test forbids.

- **CHANGED — `reloadFromStorageAsync`: empty reads are tears.** A read that
  returns "" counts as a torn write and retries inside the backoff window
  (it heals 10 ms later, like a partial file does). A missing file
  (content `undefined`) stays a valid no-credentials state — fresh installs
  have no auth.json.
- Regression test: `src/pi-auth-storage.test.ts` "0-byte tear" (verified to
  fail pre-change against the published dist and the previous hunk).
- Rebasers: same removal criterion as the parent entry — drop the whole
  auth-storage hunk when upstream ships lock-free reads with torn-read
  tolerance.

---

## @earendil-works/pi-coding-agent@0.85.1 (mid-version, corrective) — auth-storage lock-free read shape + torn-read retry

Corrects the "reload unwrap" entry above. The wrapper leak came from our own
#1405 lock-free hunk, not upstream: upstream `withLockAsync` destructures
`{ result, next }` and returns the bare credential map; the hunk returned the
callback's `{ result }` shape directly. 0.84.1/0.85.1 dists byte-verified: no
upstream defect, no issue to file. Exposure bisection (concurrent `auth check`
loops against churned auth.json, three builds) pinned the introduction to the
#1405 hunk.

The hunk now returns the bare map and retries torn reads with a short backoff
(upstream `modify()` is non-atomic truncate-then-writeFileSync; kimchi's
`syncPiAuth` writes atomically, so partial files are only observable during
an upstream modify). A persistently corrupt file resolves undefined — the
`readLatestData` caller swallows reload failures and a fresh per-read
AuthStorage holds no snapshot — and the next revision change re-arms the
reload. The previous consumer-side unwrap hunks are dropped.

- Regression tests: `src/pi-auth-storage.test.ts` + the atomicity and symlink
  tests in `src/pi-auth.test.ts`.
- Rebasers: if upstream adds lock-free reads (bare-map return, torn-read
  tolerance), drop the whole hunk; there is no upstream defect to track.
- Kept from the previous fix: `syncPiAuth` no longer chmods auth.json
  unconditionally on the no-op path.

---

## @earendil-works/pi-coding-agent@0.85.1 (mid-version, additive) — mark the run active before before_agent_start

Not an upgrade: a new hunk while the pin stayed at 0.85.1, from the workflows
regression investigation ("step became idle without the run settling"; crashes
traced to v1.13.0's work-attribution scope capture awaiting a network call in
before_agent_start for command/extension-started turns).

- **NEW — `prompt()` and `sendCustomMessage(triggerTurn)` set
  `_isAgentRunActive = true` BEFORE emitting `before_agent_start`.** pi awaits
  the emit before starting the turn, and `isIdle()` returned true during it,
  so any async handler work (memory digest retrieval, work-attribution scope
  capture — both legitimately await network calls) made idle-watchers
  (kimchi-workflows' bridge: waitForIdle → one task tick → still idle → fail
  the step) misread turn preparation as a crashed step. The flag resets on
  every non-run exit path (emit throw, empty-message return);
  `_runAgentPrompt` owns it from turn start (idempotent set). Side benefits:
  a second prompt during preparation now gets "already processing" instead of
  double-entering the run, and memory's turn-recall steer delivered during the
  emit enqueues properly instead of appending out-of-band. Verified both
  directions by tests/e2e/tui/idle-race.test.ts (fails on the unpatched
  package, passes with the patch).
- **Upstream candidate:** this is a genuine contract gap — pi permits async
  before_agent_start handlers while the session reports idle during them.
  File upstream; remove the hunks when pi fixes it.

---

## @earendil-works/pi-coding-agent@0.85.1 (mid-version, additive) — bounded confinement registry, session-file publication

Follow-up to the review-round-2 hardening above, from PR #1405 review round 3.

- **CHANGED — the live-session-file registry is bounded (LRU, 16 files).** It only
  ever grew, so old closed sessions stayed in the confinement window forever and a
  spoofed log marker pointing at an old file passed the check. Registration goes
  through `kimchiRegisterLiveSessionFile` (delete + re-add refreshes LRU position;
  oldest evicted beyond 16). A process with more than 16 concurrent sessions would
  see marker-resolution degrade (not corrupt) — acceptable, documented.
- **NEW — `globalThis.__kimchiSessionFile`.** The most recently active session file
  is published at each registration point; kimchi's tool-output-externalizer uses
  it for the mirror-loss hydration fallback (read the session log by toolCallId
  when the tmpdir mirror is gone). Best-effort: last-loaded session wins in
  ulti-session processes.

---

## @earendil-works/pi-coding-agent@0.85.1 (mid-version, additive) — marker confinement, rewrite offset refresh, mirror-free rewrite

Not an upgrade: PR #1405 review round 2 hardened the session-manager patch while
the pin stayed at 0.85.1. Rebasers can ignore this section; it exists to record
the review-round decisions and the new traps.

- **NEW — live-session-file registry + marker path confinement.** `resolveKimchiLogMessage`
  and `_kimchiOriginalToolContent` now refuse markers whose file is not (a) a live
  session file owned by a `SessionManager` in this process (module-level
  `kimchiLiveSessionFiles`, registered in `_setSessionFile`/`newSession`/
  `createBranchedSession`), or (b) for tool markers, exactly
  `globalThis.__kimchiToolOutputFile` (published by kimchi's
  `createToolOutputStore`). Spoofed markers planted in tool output can no longer
  read arbitrary local files into the session log or context. Trap: the store
  seam global is set lazily at first store creation — the serializer must treat
  `undefined` as "reject all tool markers", never as "allow".
- **CHANGED — tool markers restore the block-array shape.** `_kimchiOriginalToolContent`
  returns `[{ type: "text", text: line }]` for tool markers, matching the log-marker
  restoration, instead of the raw string. Structure survives the round trip now.
- **CHANGED — `_rewriteFile` is mirror-free and refreshes in-memory markers.** Marker
  entries restore their full content from their OWN persisted line (id-indexed byte
  scan of the current file, pre-truncation) instead of the tmpdir mirror — the log
  is the durable source of truth, so a dead mirror can no longer leak raw markers
  into a forked log. While writing, in-memory `[kimchi-ext:log]` markers are
  refreshed to the new offsets — stale offsets made a second fork (or post-rewrite
  display reads) resolve ANOTHER entry's bytes. The id→offset scan is extracted as
  `__kimchiScanLogOffsets()` and shared with the compaction eviction. Trap: the
  branch flow reassigns `this.sessionFile` BEFORE `_rewriteFile`, so the scan of the
  fresh target file is empty by design — the per-marker `_serializableEntry`
  fallback (old file, still intact) covers that path; do not "fix" the scan to read
  the old file.

---

## @earendil-works/pi-coding-agent@0.85.1 (additive) — session-log durability for externalized tool results

Kimchi session-memory work: the session manager now persists the FULL tool-result
content to the JSONL even when an extension replaced the in-memory message
content with a compact lazy marker (`[kimchi-ext:tool]` JSON handle → disk
mirror). `_serializableEntry` resolves the original from the marker's own file
reference at serialization time. No rebase trap: the change is additive inside a
new private method + two call-site swaps; the marker prefix is Kimchi-owned and
unlikely to collide. Removal: upstream exposes a content-persistence hook or
lets extensions control persisted content. See the patch header's Changes list.

## @earendil-works/pi-coding-agent@0.85.1 (additive) — compaction-history display

The TUI transcript keeps pre-compaction
history visible. SessionManager gains `buildDisplayEntries()` (full leaf
path); the interactive mode renders it at the three transcript call sites via
a capability probe, with the post-compaction handler keeping upstream's
context validation on `buildContextEntries()`. The model context is
untouched. Rebase trap: the interactive-mode hunks touch the post-compaction
event handler — keep the `entries[0]?.type !== "compaction"` validation on
the CONTEXT entries, not the display entries. Removal: upstream exposes a
display-entries hook.

## @earendil-works/pi-coding-agent@0.85.1 (additive) — compaction-history residency

After a compaction commits, pre-cut message
entries' content is evicted from memory to `[kimchi-ext:log]` markers
(byte-offset references into the session JSONL, one file scan per compaction).
Markers resolve transparently in `sessionEntryToContextMessages` (bounded LRU)
so display, ACP replay and any reader see the original blocks; the
`_serializableEntry` serializer now honors both marker prefixes so log
rewrites stay canonical. Rebase traps: the eviction walk continues PAST
`firstKeptEntryId` (pre-cut entries are its ancestors); the serializer must
parse by the MATCHED prefix's own length (tool=17, log=16 chars — an
off-by-one silently persists raw markers on rewrites) and for log markers
return the parsed `entry.message` blocks, not the raw JSONL line. Removal: when upstream exposes entry-content eviction or a
lazy content hook.

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
- **`tui-main-screen.js` — no longer patched.** At the 0.85.1 rebase the
  `PI_TUI_NO_CLEAR_SCROLLBACK` gate's hunk was rewritten from `buffer +=` to the
  new `BoundedTerminalWriter`'s `output.append(...)`; the gate was later removed
  (see the top entry), and this file is back to upstream.
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
  Closes the tracked cwd-sensitivity issue with no local change, after [kimchi#1099](https://github.com/getkimchi/kimchi/pull/1099) was closed unmerged.
