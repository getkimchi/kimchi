# Side loop: in-time views beside the main session

> Status: **experimental MVP**, gated behind `--enable-experimental-features`. TUI-only for now (see [ACP](#acp)).

The side loop watches the main session, works out **which stage the session
is in**, and keeps live cards for what matters *at that stage* in the top-right
corner. Review status, CI, test runs, deploys and Slack updates appear when
they become relevant, change as the work goes on, and step aside when the
session moves on.

You don't ask for a view, and nothing needs turning on or off:

- a card **appears** because the session produced something (a PR, a test run, a report);
- it **evolves** while it's live (CI running → lint failed → green, 2 comments, approved);
- it **parks** when the stage moves on (tests stop mattering while you deploy);
- it **retires** a few prompts after it's finished (merged PR, live deploy);
- the pane **opens itself** when something needs you (CI failed, tests failed) and **closes itself** once that's fixed.

```text
                                            ╭ in-time ──────────────── shipping ╮
  … conversation …                          │ 1 ✗ PR #42 · ✗ 1 failed · 💬 1    │
                                            │ 2 ● Tests · ✓ 42 passed           │
                                            ╰──────────────── 1 parked · /side ╯
```

`/side` is an optional override, not a switch you need: it shows or hides the
pane. `/side auto` hands control back, `/side open <n>` opens card *n*'s link,
`/side stats` prints the cost, and `/side clear` dismisses every card.

## Session stages

| Stage | Detected from | In focus (docked) |
| --- | --- | --- |
| exploring | only reads, searches | new files, messages |
| implementing | `write`/`edit` | uncommitted changes, tests, new files, context |
| verifying | test/build/lint commands | tests, changes, context |
| shipping | `git push`, `gh pr create`, `glab mr create` | PR + CI, tests, changes, messages |
| reviewing | edits or `gh pr view/checks/comment` while a PR is open, chat follow-ups | PR + review, messages, tests |
| deploying | `helm`, `kubectl apply/rollout`, `vercel`, `fly deploy`, … | deploy, PR, messages |

Whatever the stage, two kinds of card stay docked: a card created in the last
two prompts, and a failing card. Everything else outside the stage's focus is
parked (dimmed in the pane, with a "N parked" count on the dock).

During a turn, a rule over the last 16 tool calls tracks the stage live.
Once the prompt settles, d3 re-reads it from the same digest (see
[Decisions](#decisions-d3)).

## Card catalog: what to surface, and when

The Claude Code mod catalog shows which in-session views people want. Each one
maps to a card here and earns its place at a particular stage:

| Card | Inspired by | Stage | What it shows | Status |
| --- | --- | --- | --- | --- |
| **Uncommitted** | `/diff` mod (changes beside the transcript) | implementing, verifying | `N files · +a −b` from `git diff --shortstat`; disappears after commit | ✅ |
| **Tests** | — | verifying | pass/fail counts; failing → interrupt; runs counter | ✅ vitest/jest/pytest/go/cargo |
| **PR / MR** | Center PR panel | shipping, reviewing | state, CI rollup (running/failed/passed), failing checks, review decision, comments; polled live | ✅ GitHub (polled), GitLab (created, not polled) |
| **Report / file** | — | any, while fresh | generated deliverables (link opens the file); scratch files filtered by d3 | ✅ reuses `artifacts/detect.ts` |
| **Deploy** | — | deploying | target, live URL, applied/failed | ✅ helm/kubectl/vercel/fly/netlify/gcloud |
| **Messages** | — | shipping, reviewing, deploying | Slack/Teams/Discord tool posts and reads, by channel | ✅ by tool name (`*slack*`) |
| **Context** | token-weather mod | implementing, verifying | context % once ≥ 60 %, advice near compaction | ✅ |
| **Blast radius** | blast-radius mod | any | hold a risky command (`rm -rf`, force push) and show what it would touch | ⏭ needs a `tool_call` gate plus a capturing pane |
| **Replay** | replay-theater mod | reviewing | step through the last turn's edits | ⏭ |
| **Next steps** | next-steps mod | after settle | follow-up prompts per stage ("fix failing lint", "address review") | ⏭ kimchi-plugins `next` already does the generic part |
| **You should know** | Claude Code built-in side agent | any | a note when the side loop spots something you missed (PR approved while you're implementing) | ⏭ a natural d3 question |

## Decisions (d3)

Rules can say *what* happened. They're bad at *does the user care right now*.
That question is d3's shape: a batched choice with probabilities, no generated
text, sub-second, billed for input tokens only. The side loop asks three
questions, all against compact state (the latest prompt, truncated, plus a card
or activity summary; **never file contents**):

| Question | Options | When | Used for |
| --- | --- | --- | --- |
| `stage` | the six stages | once per prompt (`agent_settled`) | which cards are docked or parked |
| `relevance` | `deliverable` / `working_file` | new card | drop scratch output (`tmp/x.csv`, logs) |
| `attention` | `interrupt` / `badge` | new card, and **each time a card's tone changes** | flash the dock and open the pane, or just badge |

Rules decide when d3 is unavailable (no login, timeout, HTTP error) or turned off
with `KIMCHI_SIDE_LOOP_DECISION=0`, and when d3 answers with less than 0.6
confidence. Every card shows which path decided it (`interrupt · d3 0.90` or `badge · rule`),
and so does the stage (`stage: shipping · d3 0.88`).

Why not the chat model? It's seconds slower, generative (its answers need
parsing), costs output tokens, and spends the user's main model budget. These
are classifications, and d3 is a classifier.

The client is the core `memory/decision-gate.ts` `decide()`. Calls carry the
billing tag `side-loop:decision`, so their spend is attributed separately from
memory's.

## What it costs

The pane's footer, and `/side stats`, keep a running ledger:

```text
d3 decisions  16 calls · 4628 in-tok · 0 out-tok · avg 182 ms
              ≈ $0.00046 · 0 failed · 0 by rule
main model    0 tokens (side loop never calls it)
PR polls      9 · avg 69 ms · 0 failed
renders       158 · 35.4 ms total · avg 0.22 ms
cards         6 created · 12 updates · 1 dropped
```

(These numbers come from the scripted demo below, so d3 latency is the fake's
180 ms.) The `$` figure is an estimate. Set `KIMCHI_SIDE_LOOP_D3_USD_PER_MTOK`
to the d3 input price to get it; without that, only tokens are shown.

Cost is bounded by design:
- **One d3 call per prompt** for the stage. Card calls happen on creation and on a change of tone, never on a quiet poll.
- **PR polling** runs every 20 s (`KIMCHI_SIDE_LOOP_POLL_MS`) and 4× less often while the card is parked. It stops at merge/close. Polls use `gh`, not the model.
- **Rendering** is a pure paint of ≤ ~30 rows.

## Research summary

| Source | What it does | What we took |
| --- | --- | --- |
| **Overhaul / Center** (`kimchi-plugins/packages/overhaul`) | A full dashboard beside the chat: HUD, tasks, subagents, PR/CI board, user-described layouts. Its Auto mode asks Decision which views fit. | Proof that PR/CI beside the chat is wanted. Center is a dashboard you shape (≈45k LOC); the side loop is a handful of cards the session produces and the stage curates. A side-loop surface carries the same data as a Center panel, so the two can converge ([Roadmap](#roadmap)). |
| **Decision plugin + core `memory/decision-gate.ts`** | d3 via `/typesafe/v1/systemone`: non-generative batched choices with calibrated probabilities, ~300–450 ms, output tokens = 0. | The judgment layer, reusing the core client. |
| **JetBrains ThinkRail** | Agentic IDE on pi: an engine host, a typed versioned wire (`packages/contracts`), and a UI that depends only on the contracts. Specs/diff/changes rails. | Producers (detectors, pollers) and renderers stay separate, joined by a typed surface contract, so another surface (ACP, web) is just another renderer. |
| **A2UI** (v0.9) | Agents stream declarative UI: `createSurface`, `updateComponents` (a flat adjacency list), `updateDataModel` (JSON-pointer bound), `deleteSurface`. The client renders from its own trusted catalog. | The surface message shape and a small catalog (`text`, `status`, `link`, `kv`, `list`). Producers never send ANSI; the renderer strips control characters from every value. |
| **Claude Code mods** | In-process TS hooks (`tool.call`, `turn.complete`, `ui.render`) that draw a pane beside the transcript, a band above the prompt, a toast at top right, a status line. Hooks share module state. | The UX vocabulary and the catalog above. Pi already has all of it (table below). |

### Mapping mods onto pi

| Mod concept | Pi equivalent |
| --- | --- |
| `on('tool.call')` | `pi.on("tool_call")` (can block or rewrite) |
| `on('turn.complete')` | `pi.on("turn_end")` / `pi.on("agent_settled")` |
| pane beside transcript | `ctx.ui.custom(factory, { overlay: true, overlayOptions: { anchor: "top-right", width: "45%", nonCapturing: true } })` |
| toast at top right | the same, with a small fixed width (the side-loop dock) |
| band above prompt | `ctx.ui.setWidget(key, lines, { placement: "aboveEditor" })` |
| status line | `ctx.ui.setStatus(key, text)` |
| `$.ui.invalidate()` | `tui.requestRender()` |
| shared module state | closure state in the extension factory |
| mod commands | `pi.registerCommand` |

Pi has no `ui.render` hook to restyle built-in rows, but the side loop doesn't need one.

## Architecture

```text
 main session                        side loop (src/extensions/side-loop/)                TUI
 ────────────                ┌──────────────────────────────────────────────────┐   ┌─────────────┐
 tool_execution_start/end ──►│ signals.ts  detectors (pure) → Signal            │   │ dock        │
                             │ stage.ts    activity log → stage (rule live)      │   │ (top-right) │
 agent_settled ─────────────►│             d3 stage · changes · context · retire │   │ pane        │
                             │ decide.ts   d3 relevance/attention, rule fallback │   │ (auto/side) │
 pi.events ─────────────────►│ cards.ts    Signal → surface seed                 │   └──────▲──────┘
 "kimchi:side-surface"       │ surface.ts  A2UI-shaped store (create/update/del) ├──────────┘
   (any extension)           │ pr-watch.ts gh pr view poller (in-time updates)   │  render.ts
                             │ stats.ts    cost ledger                           │  (theme in, ANSI-safe)
                             └──────────────────────────────────────────────────┘
```

Detection and polling run off the tool path (`void onSignal(...)`), so a slow
decision or poll never delays the main loop.

### The surface contract (for other extensions)

```ts
pi.events.emit("kimchi:side-surface", {
  op: "create", surface: { id: "ferment:phase", kind: "custom", title: "Ferment · phase 2/4",
    summary: { path: "/summary" }, tone: { path: "/tone" },
    components: [
      { id: "root", type: "list", children: ["now"] },
      { id: "now", type: "text", text: { path: "/now" } },
    ],
    data: { summary: "running", tone: "pending", now: "Writing migration" } },
})
pi.events.emit("kimchi:side-surface", { op: "update", id: "ferment:phase", data: { tone: "ok", summary: "done" } })
pi.events.emit("kimchi:side-surface", { op: "delete", id: "ferment:phase" })
```

## Try it: scripted demo

`scripts/side-loop-demo/run.mjs` runs Kimchi from source in tmux with an
isolated HOME, a scripted fake LLM, a fake d3, fake `gh`/`pnpm`/`helm` on PATH
and a stub Slack tool. Nothing reaches a real provider or GitHub.

```sh
node scripts/side-loop-demo/run.mjs start   # prints the run dir; tmux session "side-loop-demo"
node scripts/side-loop-demo/run.mjs tour    # drives all 7 stages, prints the side view after each
tmux attach -t side-loop-demo               # watch or drive it yourself (window "kimchi")
node scripts/side-loop-demo/run.mjs stop <run-dir>
```

Prompts the fake model understands: *where is the retry logic* · *add backoff* ·
*run the tests* · *write a report* · *open a PR* · *post on Slack* · *deploy*.
The fake d3 is deterministic: it follows the same contract and inputs, not the
real model's judgment.

## ACP

Rendering is TUI-only in this MVP. Detection, stage tracking and polling run
without UI too, but ACP sessions draw nothing yet. The contract is
surface-agnostic JSON, so the ACP adapter would forward each store change as
a `_meta["kimchi.dev"] = { type: "side-surface", … }` notification, plus the
current stage, and IDE clients would render it with their own widgets, as A2UI
intends.

## Roadmap

1. ACP forwarding plus a VS Code/JetBrains renderer.
2. Bridge to Center: when Overhaul is loaded, publish each surface as a `CenterPanel` and let Center own the layout.
3. GitLab MR polling (`glab mr view -F json`), deploy rollout polling, and Slack thread replies (via the MCP server already in the session).
4. The ⏭ cards in the catalog, starting with *you should know* (the PR got approved or a reviewer commented while you're implementing something else).
5. Card actions (A2UI `action` → `pi.sendUserMessage`): "fix failing lint", "address review comments".
6. A `side_card` tool so the model can emit A2UI surfaces directly, validated against the catalog.
7. Persist cards across `/resume` (custom session entries, as `kimchi-artifacts` does).
