# Kimchi vs Claude Code Session Analysis

## Summary

Kimchi took about **25m59s from user prompt to final answer**, while Claude Code completed the same investigation in **5m03s**. Kimchi was roughly **5x slower**.

The main cause was not the difficulty of the task. It was orchestration overhead: Kimchi delegated a straightforward code-search task to multiple subagents, several of which ran until wall-clock timeout.

## Timing Comparison

| Harness | Time to Answer | Approach |
|---|---:|---|
| Claude Code | 5m03s | Direct search/read/synthesize loop |
| Kimchi | 25m59s | Subagent-heavy exploration with repeated timeouts |

Claude Code followed a tight path:

1. Read the bootstrap analysis document.
2. Searched for proxy-related terms.
3. Read the relevant shell and Go files.
4. Synthesized the answer.

Kimchi eventually reached a similar answer, but used a much heavier workflow.

## Kimchi Timeline

Decoded from `kimchi_slow.html`, Kimchi's expensive steps were:

| Step | Duration | Result |
|---|---:|---|
| Read `BOOTSTRAP_ANALYSIS.md` subagent | 50.5s | Wrong path, hit turn limit |
| Find bootstrap docs subagent | 21.5s | Found alternate doc |
| Broad "Trace HTTP proxy in bootstrap" subagent | 300.4s | Timed out |
| Background "ANC + Go service" subagent | 300.3s | Timed out, but wrote doc |
| Background "shell scripts" subagent | 300.2s | Timed out, partial |
| "Proxy scripts remainder" subagent | 358.3s | Timed out |

The subagent durations sum to about **22 minutes**, which explains nearly all of the slow run.

## Main Inefficiencies

### 1. Subagents Were Used Too Early

Kimchi delegated the initial file read to a subagent instead of directly checking the requested file path. That first subagent looked for `.kimchi/docs/BOOTSTRAP_ANALYSIS.md`, failed to find it, and spent **50.5s** before reporting that the relevant file was elsewhere.

For this task, direct tools like `rg`, `read`, and targeted file inspection were sufficient.

### 2. Broad Subagent Prompts Caused Timeouts

The prompts given to subagents were too large:

- `Trace HTTP proxy in bootstrap`
- `Proxy in ANC + Go service`
- `Proxy in shell scripts`
- `Proxy scripts remainder`

These are broad research tasks, not bounded file reads. As a result, agents explored too much of the repo, generated large outputs, and repeatedly hit max-duration limits.

### 3. Generated Documentation Became an Intermediate Artifact

Kimchi had subagents write findings into `.kimchi/docs/http_proxy_*.md`, then the parent agent read those generated docs and synthesized from them.

That created an unnecessary loop:

```text
source files -> subagent exploration -> generated docs -> parent reads docs -> final answer
```

A faster path would have been:

```text
source files -> parent synthesis -> final answer
```

### 4. Timeout Recovery Repeated the Same Pattern

After the first broad agent timed out, Kimchi launched two more broad background agents. When one of those produced partial output, Kimchi launched yet another subagent for the "remainder".

The recovery strategy added more timeouts instead of narrowing the problem to targeted direct searches.

### 5. Token Usage Blew Up

The top-level Kimchi session accumulated about **1.73M tokens** including cache reads/writes.

Subagent reports also show very large token counts:

| Subagent | Tokens |
|---|---:|
| Trace HTTP proxy in bootstrap | 159.5k |
| Proxy in ANC + Go service | 508.3k |
| Proxy in shell scripts | 421.0k |
| Proxy scripts remainder | 537.0k |

This is a strong sign of unbounded exploration and repeated context rebuilding.

### 6. Workflow Overhead Added Extra Turns

Kimchi also spent turns on:

- `set_phase`
- `update_todos`
- multiple `mark_todo` calls
- `clear_todos`
- background-agent result polling
- reading generated docs after subagents finished

Those operations were not the dominant cost, but they added latency and model turns around a task that did not need project-management machinery.

## Why Claude Code Was Faster

Claude Code used the shortest viable workflow:

1. Search for the requested analysis document.
2. Search for proxy variables and functions.
3. Read only files that matched the investigation.
4. Answer directly.

It did not spawn workers, write intermediate research docs, or wait for broad exploration jobs to finish.

## Root Cause

Kimchi treated a bounded codebase question as a multi-agent research project.

The expensive part was not answering "what do HTTP proxy settings configure?". The expensive part was the harness behavior:

- premature delegation,
- over-broad subagent scopes,
- timeout-driven retries,
- intermediate document generation,
- and large context/token churn.

## Recommendation

For similar read-only codebase investigations, Kimchi should prefer a direct search-first policy:

1. Run `rg` for the user-specified file or symbols.
2. Read the smallest relevant file slices.
3. Expand only when a concrete reference points elsewhere.
4. Use subagents only for independent, bounded subtasks with explicit file targets and strict output limits.
5. On timeout, switch to direct targeted inspection instead of launching another broad agent.

That would likely have reduced the Kimchi run from ~26 minutes to the same 5-7 minute range as Claude Code.
