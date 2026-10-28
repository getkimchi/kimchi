# Kimchi bridge — issues log & e2e test results

Found while building and running the fresh-install/update/auth e2e harness
(`tests/e2e/bridge/`), and while validating the developer machine. Severity:
blocker | major | minor | cosmetic.

## Results (2026-10-28, macOS arm64, sandboxed HOME, real release assets + real claude/codex)

| Chunk | Scenarios | Result |
| --- | --- | --- |
| F — fresh install | F1–F10 | **10/10 PASS** — incl. real `curl\|bash` (F9), sudo skip, idempotency, degenerate bundles |
| U — update | U1–U5, U7–U8 | **7/7 PASS** — wiring-change re-registration, code-only relink, legacy-market migration, **IS-1 repro (U5): failed refresh leaves state intact, retry completes** |
| X — uninstall/control | X1–X6 | **6/6 PASS** — incl. concurrent-installer lock, stale-lock recovery, unmanaged-binary refusal |
| A — auth (key + local) | A1–A2, A6–A9, A11–A12 | **8/8 PASS** — env key + config key verified against the real API (org `516442fe`), signed-out stays local, all three reporting-off paths, flush/export/disable, gateway key contract |
| A4 — bridge OAuth (interactive) | real SSO, org pinned | **PASS** — verified, org bound, proxy healthy |
| A3 / A5 — kimchi SSO + `--from-kimchi` | | **environment-blocked** (sandbox artifact, IS-14); production path confirmed structurally |
| P1 / P2 — prompts via gateway | OAuth proxy / key direct | **partial: claude ✓, codex ✗ (IS-12)** |
| Real-machine fix (rc.5 → rc.8) | | **done + re-validated** — receipts, symlinks, `installed/code`, plugin lists, gateway restarted |

---

## 1. (major) `refreshBridge` fails silently during `kimchi update`

Found on the developer machine: `kimchi update` applied the new binary + share
(bridge rc.8) but the installed bridge stayed rc.5 — `current.mjs`, receipts
and `installed/code` untouched, no `releases/v0.1.0-rc.8`, no lock. Root cause:
`refreshBridge` (`src/update/install.ts`) spawns a detached, stdio-ignored
`install.sh update` child; when it fails (e.g. a client missing from the child
env) the failure is invisible. **Reproduced in scenario U5** — a failed refresh
leaves old state fully intact and the next update retries (by design), but the
user gets no signal. Fix: log the refresh child's output; surface a post-update
"work reporting not updated — rerun kimchi update" notice; consider
non-detached with a timeout.

## 2. (minor) duplicate gateway processes

Two `gateway run` daemons alive, only one recorded in `gateway.json`.
**Reconfirmed live:** the rc.8 refresh left the old rc.5 daemon holding :8766,
and `gateway disable && gateway enable` spawned two rc.8 daemons (83317/83319).
Fix: on `activate`/`gateway ensure`, reap any `gateway run` not recorded in
`gateway.json`.

## 3. (cosmetic) stale repo-state entries in `~/.cache/kimchi/state.json`

`state.json` still caches `castai/kimchi` and `castai/kimchi-dev` repo-state
after the move to `getkimchi/kimchi`; never pruned.

## 4. (observation) codex marketplace source pins an old release dir

`codex plugin list` shows the marketplace source at
`releases/v0.1.0-rc.4/...` while the runtime runs the current bundle through
`current.mjs` — expected retention; hooks route through the per-release shim
(verified in U7: shims report the new version after an update).

## 5. (minor) release gap — no released kimchi before v1.22.0 bundles the bridge

v1.21.5/v1.21.6 tarballs contain no `share/kimchi/bridge`; bundling started in
v1.22.0 (rc.8). Users on v1.21.x who update get no bridge unless they rerun the
installer; no release note mentions this.

## 6. (minor) kimchi-bridge releases before rc.8 lack the package asset

`v0.1.0-rc.5` release assets are `install.sh` + `kimchi-adapters_*` tarballs —
no `kimchi-bridge.tar.gz`; the packaged format starts at rc.8. Update testing
for pre-rc.8 bridges is only possible from installed copies.

## 7. (cosmetic) rc.5 package ships debug artifacts

`fb_funcs.txt` and `fb_raw.txt` present in the installed rc.5 release package.

## 8. (minor) misleading "does not support native plugins" error

When a client CLI fails its preflight for environmental reasons (e.g. a
cmux-wrapped `claude` whose real binary isn't on PATH), the installer reports
"claude does not support native plugins. Update the official CLI." and swallows
the client's own error. Fix: echo the failed command's stderr.

## 9. (major, open investigation) reported kimchi version depends on install path

The SAME release binary (sha `720b2c0c…` = real v1.21.6) reports `1.21.6` from
the fixture directory but `1.22.0` copied into a sandbox `bin/` — identical
bytes, same env; the output is a *bare* version (not `kimchi x.y.z`), so
`--version` bypasses `runVersion`. Sandbox-env-specific (real HOME reports the
embedded version). Blocked the `kimchi update`-driven U6 scenarios, which were
pivoted to drive `refreshBridge`'s mechanism directly (share swap + bundled
`install.sh update`) — that pivot validated all bridge-update mechanics.

## 10. (minor) `gateway enable` with a bare API key needs `KIMCHI_BASE_URL`

A key sign-in can't derive the gateway URL (it lives in the OAuth endpoint
config), so `gateway enable` fails with a clear hint; `KIMCHI_BASE_URL`
unlocks direct mode (verified in A12). The README ("API-key sign-ins connect
direct") doesn't mention the requirement.

## 11. (major) codex fails through the gateway; claude works

`codex exec` fails in BOTH direct-key and OAuth-proxy modes: "stream
disconnected before completion: stream closed before response.completed" after
5 reconnections. Proxy log: `POST /openai/v1/responses -> 200` every time
(822–1629 ms) — the upstream stream closes before a complete response, while
`/anthropic/v1/messages` is clean. Not auth-related (both modes fail). Bridge
rc.9's changelog explicitly names Codex 0.165 — re-test with an rc.9 bundle.
Also: `POST /anthropic/api/hello -> 404` noise in the proxy log (tolerated by
claude).

## 12. (UX/consent, raised by the user) install auto-configures claude/codex without confirmation

`scripts/install.sh` silently modifies the user's Claude Code and Codex
setups: registers the `kimchi-work` plugin + marketplace in every client found
on PATH, and — once a sign-in exists — routes the clients' model requests
through the Kimchi LLM gateway, all without an explicit per-client
confirmation step. Undo exists (`kimchi-bridge uninstall both`,
`kimchi-bridge gateway disable`) but isn't presented at install time. Ask:
confirm whether the installer should ask before modifying each client (or
offer an opt-out), and whether enabling the gateway on sign-in should be an
explicit consent step.

## 13. (harness observation) kimchi SSO credential location diverged in-sandbox

`kimchi login` under a sandboxed HOME (no `ENV_AGENT_DIR`) completed its
browser flow but produced no `~/.config/kimchi/harness/auth.json` at the
bridge's hardcoded path, so A3 re-exercised the config-key path and
`--from-kimchi` reported "No saved Kimchi sign-in found". Production aligns
(real machine's `harness/auth.json` exists, `{type: api_key}` supported for
reading). Harness fix: set `ENV_AGENT_DIR`; optionally make `seedFromKimchi`'s
error distinguish a shape mismatch from a missing file.

---

*Harness: `tests/e2e/bridge/{sandbox,fresh-install,update,auth,prompting,control,interactive-ui}.sh`, plan at
`.kimchi/plans/bridge-e2e-test-plan.md`, fixtures/logs under `/tmp/kimchi-e2e-fixtures` and
`/tmp/kimchi-e2e-runs`.*

## 14. (major) codex model route fails for EVERY model via the gateway (UI-verified)

Interactive (tmux) verification of the gateway-wired clients — the user's ask: run
interactively, see model lists, choose models, send prompts.

- **Claude Code: fully works.** First-run trust prompt, main UI, `/model` picker lists the
gateway catalog (Default/Opus 5 1M, Opus, Sonnet 5, Sonnet 5 1M, Haiku — Kimchi's per-Mtok
pricing), selecting Sonnet applies it ("Set model to Sonnet 5…", header shows Sonnet 5), and a
prompt round-trips: "Reply with exactly: UI-17K" → `UI-17K` in 4s.
- **Codex: UI works, model route fails upstream.** Hooks-review trust flow, main UI, `/model`
picker shows the 30-model gateway catalog (incl. **glm-5.3-flash**, minimax-m3, deepseek,
kimi, gemma), selection applies ("Model changed to claude-sonnet-4-5 low", "Model changed to
glm-5.3-flash … for this session only"), prompts submit — but the request ALWAYS fails with a
503 (nginx `Service Unavailable`) or "stream disconnected before completion" on
`/openai/v1/responses`, for **both claude-sonnet-4-5 and glm-5.3-flash**. IS-12 is
model-independent and route-specific (the Anthropic `messages` route is clean).
- **Observation:** codex's picker entry NAMES don't render in tmux `capture-pane` (blank rows);
  the list is only verifiable via `model_catalog.json` or the "Model changed to <slug>" toast.
- **Fix:** upgrade the bundled bridge to rc.9 (changelog names Codex 0.165) and re-test.
## 15. C1 follow-up (2026-10-28) — codex/gateway route: rc.9 does NOT fix; backend needs a codex-0.165 repro

- rc.9 bundle (sha matches `bundle-bridge.sh` pin) reproduces the same
  "stream disconnected before completion" in direct mode.
- Gateway backend is healthy in isolation: `curl` to
  `https://llm.kimchi.dev/openai/v1/responses` with `stream:true` succeeds for
  `glm-5.3-flash` and `minimax-m3` (string and array `input`, with
  `x-codex-*`/`originator`/`x-client-request-id` headers; 32-138 SSE events,
  `response.completed` present). `claude-sonnet-4-5` on that route returns
  HTTP 503 (nginx) — claude models are NOT servable over `/openai/v1/responses`
  (expected: use the anthropic route for claude models).
- codex 0.165's exact wire request was captured (22 118-byte body: `model`
  minimax-m3, `stream:true`, long array `input` with skills instructions +
  `x-codex-beta-features: remote_compaction_v2` headers). Every body/header
  subset tested separately succeeds; the full codex payload fails client-side
  with "stream disconnected before completion".
- **Action:** file a gateway-backend ticket with the captured codex payload
  (wire-echo) — the trigger is in codex 0.165's full request shape, not the
  bridge (rc.9) or the simple curl paths. Bridge is exonerated.

## Remediation status (2026-10-28, implementation pass 1)

| Issue | Status | Evidence |
| --- | --- | --- |
| IS-1 refreshBridge silent failure | **FIXED (C2, kimchi-dev)** | stream to `~/.local/share/kimchi-bridge/refresh.log`, info line + 10 s bounded wait + visible "did not complete" warning in `applyUpdate`; unit-tested (37/37 in `src/update/{install,workflow}`) |
| IS-12 codex route | **UNRESOLVED — backend ticket (C1)** | rc.9 does NOT fix; gateway stream curl works for glm-5.3-flash/minimax-m3, 503 for claude-sonnet-4-5; codex 0.165 wire request captured; needs a gateway-backend repro with the full 22 KB payload |
| NEW shared auth (C3, bridge) | **IMPLEMENTED + e2e-verified** | `kimchi-bridge login` now binds any existing Kimchi sign-in (no browser, 2.6 s), gateway URL derived from the sign-in region (no `KIMCHI_BASE_URL` for us/eu; IS-11 folded in), no `gateway-auth.json` created; tests 118/118 (13 gateway incl. new region test) |
| IS-2 duplicate daemons | **FIXED (C4, bridge)** | duplicate `gateway run` that loses the preferred-port race now exits instead of scanning onto +1 and lingering; typecheck + 13/13 gateway tests; real machine now single daemon (83317) |
| IS-11 KIMCHI_BASE_URL requirement | **FIXED (C3)** | region-derived `llm.kimchi.dev` / `llm.eu.kimchi.dev` for kimchi app API URLs |
| IS-13 install consent | **PENDING PRODUCT DECISION (C5)** | update-path notice + `kimchi bridge setup` designed in the plan; TTY prompt vs opt-out flag needs a call |
| IS-8 misleading native-plugins error | **FIXED (C6)** | installer preflight now includes the failing command's stderr in the error |
| IS-7 debug files in bundle | **RESOLVED BY CONSTRUCTION (C6)** | `package.ts` ships only explicit entries; rebuilt bundle has no `fb_*`/`.txt` strays |
| IS-3 stale state.json, IS-5/IS-6 release notes, IS-4 verify | PENDING (C6/C7) | documented; release-note wording next release |
| IS-9 version anomaly, IS-14 harness path | PENDING (C7 spikes) | findings in this document; no code change yet |

## Remediation pass 2 (2026-10-28) — consent decision + scope corrections

- **C3 scope corrected (user decision):** Kimchi sign-in does NOT auto-enable
  gateway routing. `kimchi-bridge login` adoption path now binds reporting
  only and prints how to enable (`kimchi bridge setup` / `kimchi-bridge
  gateway enable`). The browser SSO login still enables the gateway (explicit
  act). README updated. Bridge suite 118/118 + typecheck.
- **C5 implemented per user choices:** installer (TTY) prompts per client with
  y/N, `KIMCHI_BRIDGE_SKIP=1` for scripts, piped installs default to yes with
  an undo note; the "do it later" path is the new `kimchi bridge
  setup|disable|remove|status` command (src/commands/bridge.ts; registered;
  dispatch tests 11/11); the updater shows a **one-time first-contact notice**
  ("install it and route inference with `kimchi bridge setup`; undo with
  `kimchi bridge remove`") with a marker so it never nags; update unit tests
  37/37.
- **IS-9 (version anomaly) — root cause found:** kimchi deliberately falls
  `--version` through to upstream pi (`dispatch.test.ts`: "falls through for
  --version (pi prints it)"), so the path-dependent bare version is pi's print,
  not `getVersion()`. Fix option (kimchi-side): intercept `--version` in
  dispatch and print `kimchi ${getVersion()}` deterministically. Left as an
  open decision (touches CLI output contract).
- **IS-14:** still needs one sandbox bind (`ENV_AGENT_DIR`) + a browser click
  to re-run A3/A5 to completion.

## Full-suite rerun on the fixed build (2026-10-28)

Fixture `v1.22.0-patched` = freshly built kimchi binary (C2/C5 patches) +
edited bridge bundle rc.9 (C3/C4, incl. no-auto-enable login).

| Suite / scenario | Result |
| --- | --- |
| F + U + X regression (default rc.8 fixture) | **all PASS** (F 10/10, U 7/7, X 6/6) |
| A-chunk on patched fixture (key) | **8/8 PASS** — incl. A12 region-derived gateway (no KIMCHI_BASE_URL) + unknown-region decline |
| Decision 3: `kimchi-bridge login` with a sign-in | **PASS** — reporting verified, `enabled:false`, "Gateway not enabled — run `kimchi bridge setup`…" printed |
| `kimchi bridge status` (built binary) | PASS (real machine: healthy proxy, rc.8 v0.1.0-rc.8, pid 83317) |
| `kimchi bridge disable` (built binary, sandbox) | PASS — gateway off + capture paused, exit 0 |
| `kimchi bridge setup/remove` in-sandbox | harness-stdio artifact with the dev binary (silent death after spawn); the same installer paths are green via unit tests + X-chunk `uninstall both`; re-verify against a release build |
| P1/P2 prompts | unchanged — claude ✓, codex ✗ (IS-12, backend ticket) |

kimchi-dev units: update 37/37, dispatch 11/11. Bridge: typecheck + 118/118 incl.
the no-auto-enable login path.
