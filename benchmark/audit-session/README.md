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
| `-m`, `--model MODEL` | Model override (default: `kimchi-dev/claude-opus-4-7` for kimchi, `claude-opus-4-7` for claude) |
| `-h`, `--help` | Show help |

## Runners

| Runner | Mode | Permissions | Default model |
|--------|------|-------------|---------------|
| `kimchi` | interactive, yolo | all tools allowed | `kimchi-dev/claude-opus-4-7` |
| `claude` | interactive | `--dangerously-skip-permissions` | `claude-opus-4-7` |

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

## Prerequisites

- `kimchi` and/or `claude` CLI available on PATH
- `jq` recommended (used for session parsing; falls back to grep)
- Session JSONL files (from `~/.config/kimchi/harness/sessions/` or `benchmark/manual/`)
