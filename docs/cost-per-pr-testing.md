# Cost per PR: local attribution and test lab

This change supplies local request/work/commit records. PR lookup, cost aggregation, semantic matching and uploads are separate follow-up work.

## Run the checks

```sh
pnpm exec vitest run src/extensions/work-attribution.test.ts src/extensions/request-timing.test.ts src/shared/planning/plan-markdown.test.ts
pnpm run test:e2e:tui -- work-attribution --debug
```

The TUI test holds the first fake response and reads the ledger before releasing it. It then executes a real Git commit and checks its work ID. A second workflow saves a plan, exits Kimchi, starts a new session and continues the same work. The shared fixture supplies temporary HOME/workdir, a fake OpenAI server and terminal traces.

## Open the TMUX lab

```sh
pnpm run build:binary
pnpm exec tsx scripts/cost-per-pr-lab.mjs
```

Keep the lab process running. It prints its temporary home, TMUX socket directory, run directory and ledger path. It uses the bundled `kimchi-tmux` controller, fake credentials, a loopback model server, disabled telemetry and a dedicated TMUX server. No real model calls are needed.

Use the printed paths in another terminal:

```sh
export TMUX_TMPDIR='<printed socket directory>'
node resources/skills/kimchi-tmux/scripts/harness-live.mjs status '<run directory>'
node resources/skills/kimchi-tmux/scripts/harness-live.mjs send '<run directory>' 'Say hello'
node resources/skills/kimchi-tmux/scripts/harness-live.mjs status '<run directory>'
```

Check readiness before sending input. The lab starts in Plan mode. To exercise commits with a scripted fake response, use `/permissions mode yolo` inside this isolated lab. Press Enter in the lab process to stop only its TMUX session, save the ledger and fake request capture under the run directory, and remove its temporary home.

Pass a JSON array of fake responses to replay another workflow:

```sh
pnpm exec tsx scripts/cost-per-pr-lab.mjs /absolute/path/responses.json
```

For example, this response commits one synthetic file, then ends the turn:

```json
[
  {"toolCalls":[{"function":{"name":"bash","arguments":"{\"command\":\"printf hello > hello.txt && git add hello.txt && git commit -m 'Add hello'\"}"}}]},
  {"stream":["Committed the greeting."]}
]
```

Response fields follow `tests/e2e/tui/support/fake-openai-server.ts`. This fixture can also return errors, token usage, child-agent responses and routed model IDs for later attribution tasks. The Git repository stays local; task #1 does not query or create PRs.

## Continue or separate work

`/work` shows the current UUID. `/work new` starts a separate work item. `/work .kimchi/plans/<name>.md` loads a saved plan's work ID before the next model call. Use the explicit command before implementing a plan in a new session when its first request must include the planning costs.

Saved plans carry `<!-- kimchi-work-id: UUID -->`. Reading or comparing a plan does not switch work; `/work <path>` expresses the continuation explicitly. A plan pasted without metadata remains separate until task #4.2 implements semantic matching.

## Local record contract

Records live in `<agent directory>/work-attribution/<session ID>.jsonl`, including for memory-only child sessions. Each record has `version`, `type`, `sessionId`, `workId`, `cwd` and `recordedAt`. Request records add a unique `requestId`, provider and model when available. Commit records add the SHA, repository and worktree. Keep local metadata local; task #4.1 defines the later IDs-and-totals upload boundary.

Records are appended before request dispatch, independently of telemetry. Request IDs also appear in `X-Request-Id` and in session request diagnostics. Children receive a snapshot of the parent's work ID, so later parent task changes do not move their costs.

Provider-internal retries in the direct Codex provider can reuse one request ID; this POC's CastAI OpenAI-compatible path disables internal SDK retries. Storage failures surface a warning; Pi catches extension-hook errors and can continue inference, so a failed disk must not be treated as complete attribution. Session model metadata describes the configured model, which can differ from a routed or summarization model.

Commit observation records native `git commit` ref transactions from the Bash tool, including `git -C`, shell `cd`, root commits and amendments. Checkout, reset, pull and external commits are excluded. Concurrent ambiguous Git processes and traces over 8 MiB remain unresolved; this is not file-level authorship attribution. Temporary native Git traces are removed after the command.

## Reuse decision

The pinned Pi headers hook supplies the integration point, including compaction and branch summaries. Git AI's [agent-v1 implementation](https://github.com/git-ai-project/git-ai/blob/main/src/commands/checkpoint_agent/presets/agent_v1.rs) supplies edit and shell checkpoints in its Rust CLI; it does not provide Kimchi's request/work identity store. Task #1 uses the existing hooks and native Git evidence without adding Git AI as a required installation. Its broader line-attribution machinery remains a separate integration decision.
