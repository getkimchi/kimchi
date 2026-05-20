# Session Phase Audit

Audits a completed kimchi harness session, analyzing phase discipline, code quality, model alignment, and cost efficiency. Produces a graded report written to `.kimchi/audits/`.

## Files

- `audit-session.sh` -- entry point script; discovers sessions, handles selection, invokes the auditor
- `audit-session-prompt.md` -- agent prompt template with placeholders for session file and ID

## Usage

```sh
# Interactive session picker, default runner (kimchi)
./benchmark/audit-session/audit-session.sh

# Run with claude-code instead
./benchmark/audit-session/audit-session.sh -r claude

# Custom model
./benchmark/audit-session/audit-session.sh -m kimchi-dev/kimi-k2.6
./benchmark/audit-session/audit-session.sh -r claude -m opus

# Audit a specific session file directly
./benchmark/audit-session/audit-session.sh path/to/session.jsonl

# Show only the last 5 sessions in the picker
./benchmark/audit-session/audit-session.sh -n 5

# List sessions without launching an audit
./benchmark/audit-session/audit-session.sh -l
./benchmark/audit-session/audit-session.sh -l -n 3
```

## Options

| Flag | Description |
|------|-------------|
| `-l`, `--list` | List available sessions and exit |
| `-n`, `--last N` | Show only the last N sessions (default: all) |
| `-d`, `--dir DIR` | Use DIR instead of cwd to locate sessions |
| `-r`, `--runner CMD` | Harness to use: `kimchi` (default) or `claude` |
| `-m`, `--model MODEL` | Model override (default: `kimchi-dev/claude-opus-4-6` for kimchi, `claude-opus-4-6` for claude) |
| `-h`, `--help` | Show help |

## Runners

| Runner | Mode | Permissions | Default model |
|--------|------|-------------|---------------|
| `kimchi` | interactive, yolo | all tools allowed | `kimchi-dev/claude-opus-4-6` |
| `claude` | interactive | `--dangerously-skip-permissions` | `claude-opus-4-6` |

## What the audit evaluates

The agent grades the session across 6 dimensions:

| Dimension | Weight | What it checks |
|-----------|--------|----------------|
| Phase Discipline | 15% | Logical phase ordering, timely transitions, phase-work alignment |
| Architecture | 20% | Design decision timing, module boundaries, project conventions |
| Code Quality | 20% | Lint results, naming, duplication, over-engineering |
| Testing | 20% | Coverage, negative paths, test organization patterns |
| Phase-Model Alignment | 10% | Expensive models for complex phases, cheap models for routine work |
| Cost Efficiency | 15% | Per-phase cost breakdown, counterfactual analysis |

## Output

The audit report is written to `.kimchi/audits/{sessionId}-AUDIT.md` in the project directory. It includes:

- Summary grade table
- Phase timeline with duration, model, turn count, and cost per phase
- Detailed findings per dimension
- Tool usage breakdown by phase
- Cost counterfactuals (opus-only, phase-optimized)
- Top 3 actionable improvements

## Example: benchmark a complex task then audit it

This walkthrough runs a complex benchmark session with `kimi-k2.6`, then audits the result.

### 1. Create a benchmark session (if needed)

```sh
cd benchmark/manual
./new-session.sh
```

This creates `sessions/session-NN/` with run scripts for every task x model combination.

### 2. Run the complex task

```sh
./sessions/session-02/run-complex-kimi-k2.6.sh
```

Wait for completion. The JSONL transcript is saved to:

```
sessions/session-02/runs/complex-kimi-k2.6/session-YYYYMMDD-HHMMSS.jsonl
```

### 3. Audit the session

Pass the session file directly:

```sh
./benchmark/audit-session/audit-session.sh \
    benchmark/manual/sessions/session-02/runs/complex-kimi-k2.6/session-20260511-124841.jsonl
```

Or use claude-code with Opus for the audit:

```sh
./benchmark/audit-session/audit-session.sh -r claude -m opus \
    benchmark/manual/sessions/session-02/runs/complex-kimi-k2.6/session-20260511-124841.jsonl
```

### 4. Review the report

The audit agent writes its findings to:

```
.kimchi/audits/session-20260511-124841-AUDIT.md
```

The report contains phase-by-phase cost breakdown, grade summary, and actionable improvements. Use it to decide whether to adjust model assignments, phase transitions, or task decomposition for future sessions.

## How it works

1. Encodes the working directory path to find the matching sessions directory
2. Lists sessions with timestamps and first user prompt for easy identification
3. Substitutes the selected session path into the prompt template
4. Launches the chosen runner (kimchi or claude-code) in interactive mode with the prompt

## Metrics Captured

The audit evaluates 13 dimensions of session quality. Sections 1–6 are graded; 7–13 produce structural metrics.

| # | Metric | Description |
|---|--------|-------------|
| 1 | Phase Discipline | Logical phase ordering, timely transitions, phase-work alignment |
| 2 | Architecture & Design | Decision timing, module boundaries, project conventions |
| 3 | Code Quality | Lint results, naming, duplication, over-engineering |
| 4 | Testing Strategy | Coverage, negative paths, test organization patterns |
| 5 | Phase-Model Alignment | Expensive models for complex phases, cheap for routine work |
| 6 | Cost Efficiency | Per-phase cost breakdown, counterfactual analysis |
| 7 | Per-Turn Model Attribution | Active model per turn, provider, switch boundaries |
| 8 | Routing Decision Rationale | What triggered each model switch (phase, tool call, explicit text) |
| 9 | Switching Latency | ms between model_change and first assistant message per model |
| 10 | Subagent Lifecycle | Loops, budget usage, context completeness per subagent invocation |
| 11 | Token Consumption per Task Class | Tokens/cost per class (explore, plan, build, review, research, orchestration) |
| 12 | Cost per Completed Task | Cost of each task block from start to terminal state |
| 13 | OSS vs Non-OSS Utilization | Token-based and cost-based ratio of OSS model usage |

## Structured Output

Every audit run produces two files:

| File | Description |
|------|-------------|
| `.kimchi/audits/{sessionId}-{runner}-{model}-AUDIT.md` | Human-readable graded report |
| `.kimchi/audits/{sessionId}-{runner}-{model}-AUDIT.json` | Machine-readable sidecar for automated comparison |

The JSON sidecar conforms to schema version `1.0.0` with these top-level keys:

```json
{
  "schemaVersion": "1.0.0",
  "sessionId": "<session-id>",
  "timestamp": "<iso-timestamp>",
  "modelsUsed": [{ "modelId", "provider", "turns", "tokens": {...}, "cost", "isOss" }],
  "switches": [{ "from", "to", "timestamp", "latencyMs", "rationale" }],
  "subagents": [{ "delegateModel", "budget", "looped", "completed" }],
  "taskClasses": { "explore": { "tokens": {...}, "cost" }, ... },
  "completedTasks": [{ "label", "turnRange", "cost", "terminalState" }],
  "ossRatio": { "byTokens": 0.0, "byCost": 0.0 },
  "aggregates": { "totalTokens", "totalCost", "totalTurns", "totalSwitches", "totalSubagents", "errors" }
}
```

`jq` is recommended (but optional) for validation — if `jq` is present, the script validates the JSON before writing the sidecar.

## Usage for Automated Comparison

Compare two audit runs with `jq`:

```sh
# Compare total cost between two sessions
jq -s '.[0].aggregates.totalCost as $a | .[1].aggregates.totalCost as $b |
  "Session 1: $\($a)" , "Session 2: $\($b)" , "Delta: $\($b - $a)"' \
  .kimchi/audits/session-AUDIT.json .kimchi/audits/session-BUDIT.json

# Compare OSS ratio between two runs
jq -s '"Run 1 OSS cost ratio: \(.[0].ossRatio.byCost * 100 | . * 100 | floor / 100)%",
       "Run 2 OSS cost ratio: \(.[1].ossRatio.byCost * 100 | . * 100 | floor / 100)%"' \
  .kimchi/audits/session-AUDIT.json .kimchi/audits/session-BUDIT.json

# Find which model consumed the most in each session
jq -s 'map(.modelsUsed | max_by(.cost)) | .
  | "Session 1 most expensive: \(.[0].modelId) ($\([0].cost))",
       "Session 2 most expensive: \(.[1].modelId) ($\([1].cost))"' \
  .kimchi/audits/session-AUDIT.json .kimchi/audits/session-BUDIT.json

# Compare subagent loop rates
jq -s 'map(.subagents | map(.looped) | add / length) | .
  | "Run 1 loop rate: \(.[0] * 100 | . * 10 | floor / 10)%",
       "Run 2 loop rate: \(.[1] * 100 | . * 10 | floor / 10)%"' \
  .kimchi/audits/session-AUDIT.json .kimchi/audits/session-BUDIT.json

# Aggregate cost across many runs (for batch comparison)
jq -s 'map(.aggregates.totalCost) | add' .kimchi/audits/*-AUDIT.json
```

## Prerequisites

- `kimchi` and/or `claude` CLI available on PATH
- `jq` recommended (used for session parsing and JSON sidecar validation; falls back to grep)
- Session JSONL files (from `~/.config/kimchi/harness/sessions/` or `benchmark/manual/`)
