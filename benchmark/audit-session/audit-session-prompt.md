# Session Phase Quality & Cost Audit

You are auditing session **{sessionId}** from file `{sessionFile}`. Your job is to produce a comprehensive, honest, evidence-based quality report analyzing how each phase (explore, research, plan, build, review) was used. You are not here to celebrate — you are here to find what worked, what didn't, and what to improve.

## Instructions

Execute each section below in order. Collect evidence via tool calls. Write findings to the audit artifact at the end.

---

### Step 1: Gather Evidence

Run these commands and read these files to build your evidence base. Do NOT skip any step.

```
1. Read the session JSONL file: {sessionFile}
   - Parse the header line (type: "session") for session metadata (id, cwd, timestamp)
   - Extract all entries, noting their type, id, parentId, and timestamp
2. Build the phase timeline:
   a. The initial phase is always "explore" (set at session_start)
   b. Scan all "message" entries for assistant tool_use blocks with name: "set_phase"
   c. Extract the phase parameter from each set_phase call and its timestamp
   d. Build a chronological map: [timestamp_range] -> phase
3. Extract model changes:
   - Scan for all "model_change" entries (type: "model_change")
   - Record: timestamp, provider, modelId
   - Correlate model changes with the phase timeline
4. Extract per-turn usage data:
   - For each "message" entry with role: "assistant", extract:
     usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost.total
   - Tag each turn with its active phase (from the timeline in step 2)
   - Tag each turn with its active model (from model_change entries in step 3)
5. Extract tool usage:
   - For each assistant message, scan content blocks for type: "tool_use"
   - Record tool name, frequency, and which phase each tool call occurred in
6. Extract behaviour data (if present):
   - Scan for "behaviour_loaded", "behaviour_eval", "behaviour_session_summary" entries
   - Note which behaviours fired and in which phases
7. Read project context files (if they exist in the session's cwd):
   - README.md
   - CLAUDE.md
   - .kimchi/ directory contents
```

For production code evidence:
```
8. Find new/modified source files produced during this session:
    git log --oneline --since="<session_start_timestamp>" -- ':!.gsd/' ':!.kimchi/'
    git diff --stat <first_session_commit>..HEAD -- ':!.gsd/' ':!.kimchi/'
    (If no commits found, check: git status --short for uncommitted work)
9. Count production LOC and test LOC changed:
    wc -l <changed source files>
    wc -l <changed test files>
10. Run linter on changed code (if applicable):
    For TypeScript: npx tsc --noEmit
    For Go: go vet ./...
    For Python: ruff check <directories>
11. Run relevant tests:
    npm test / go test ./... / pytest (as appropriate for the project)
12. Check for stale temp files, build artifacts, or other items that shouldn't be committed
```

---

### Step 2: Evaluate — 6 Dimensions

Score each dimension on a **letter grade scale: A, A-, B+, B, B-, C+, C, C-, D, F**.

Provide the grade, 2-4 bullet strengths, and 2-4 bullet weaknesses with specific evidence (timestamps, turn numbers, phase names, cost figures, file names). No hand-waving.

#### 2.1 Phase Discipline

Evaluate:
- Was the session started in "explore" and did it progress through phases in a logical order?
- Were phase transitions timely? (e.g., not staying in "explore" while already writing code)
- Was the "plan" phase actually used before "build"? Did it produce a meaningful plan?
- Was "review" used at the end? Did it catch anything?
- Were there unnecessary phase transitions or phase churn?
- Did the phase labels accurately reflect the work being done? (e.g., was exploration happening during "build"?)
- Was time allocation across phases proportional to session goals?

#### 2.2 Architecture & Design Decisions

Evaluate:
- Were design decisions made during "plan" or "research" phases (not ad-hoc during "build")?
- Are module boundaries clean? (single-responsibility, clear public API)
- Are cross-module dependencies sensible? (no circular imports, no god modules)
- Does the code follow established project patterns? (check CLAUDE.md, existing conventions)
- Are new abstractions justified? (no speculative frameworks)
- Is error handling structural? (not just try/catch swallowing)
- Are there deprecated API usages or dead code introduced?

#### 2.3 Code Quality

Evaluate:
- Lint results: how many violations in new/changed code?
- Are there dead variables, unused imports, or unreachable code?
- Is there excessive code duplication? (same pattern repeated >3 times)
- Are naming conventions consistent and self-explanatory? (per CLAUDE.md: no comments, use clear names)
- Is logging structured and useful? (correlation IDs, no secrets, actionable messages)
- Were unnecessary comments added? (CLAUDE.md says avoid comments, use self-explanatory names)
- Is the code over-engineered for the task at hand?

#### 2.4 Testing Strategy

Evaluate:
- Test count and pass/fail/skip breakdown
- Test-to-production-code LOC ratio (target: >1.0)
- Are negative paths tested? (auth failures, malformed input, errors, timeouts)
- Is there an integration/e2e test that validates the full pipeline?
- Do tests use struct-to-struct comparison where possible? (per CLAUDE.md)
- Are test cases organized using maps? (per CLAUDE.md)
- Are there deprecation warnings or test smells? (hardcoded counts, fragile assertions)

#### 2.5 Phase-Model Alignment

Evaluate:
- Were expensive models (Opus) used primarily for complex phases (plan, review)?
- Were cheaper models (Sonnet, Haiku) used for routine execution (build)?
- Were model switches correlated with phase transitions or arbitrary?
- Did model capabilities match phase requirements? (e.g., was a weak model used for planning?)
- Were there missed opportunities to use a cheaper model?
- Were there phases where a stronger model would have prevented rework?

#### 2.6 Cost Efficiency

Use the following model pricing reference for all cost calculations. Prices are per token.

**Kimchi-dev model prices:**

| Model | Input $/token | Output $/token | Input $/M | Output $/M |
|-------|--------------|----------------|-----------|------------|
| MiniMax-M2.5 | 3.0e-07 | 1.2e-06 | $0.30 | $1.20 |
| MiniMax-M2.7 | 3.0e-07 | 1.2e-06 | $0.30 | $1.20 |
| Qwen3-Coder-Next-FP8 | 5.0e-07 | 1.2e-06 | $0.50 | $1.20 |
| Kimi-K2.5 | 6.0e-07 | 3.0e-06 | $0.60 | $3.00 |
| Kimi-K2.6 | 1.2e-06 | 4.5e-06 | $1.20 | $4.50 |
| Nemotron-3-Super-120B | 3.0e-07 | 7.5e-07 | $0.30 | $0.75 |

**Anthropic model prices (for counterfactuals):**

| Model | Input $/M | Output $/M |
|-------|-----------|------------|
| Claude Opus | $15.00 | $75.00 |
| Claude Sonnet | $3.00 | $15.00 |

When matching model IDs from session data, use substring matching (e.g., "kimi-k2.6" matches "Kimi-K2.6", "minimax-m2.5" matches "MiniMax-M2.5"). If a model is not in this table, note it and use the cost from the session's `usage.cost.total` field directly.

Compute and present:

**A. Actual cost breakdown by phase and model:**

| Phase | Model | Turns | Input Tokens | Output Tokens | Cache Read | Cache Write | Cost |
|-------|-------|-------|-------------|---------------|------------|-------------|------|
| explore | (from session data) | | | | | | |
| research | | | | | | | |
| plan | | | | | | | |
| build | | | | | | | |
| review | | | | | | | |
| **TOTAL** | | | | | | | |

**B. Phase cost distribution:**

| Phase | Cost | % of Total | Turns | Avg Cost/Turn |
|-------|------|------------|-------|---------------|
| explore | $X | X% | N | $X |
| research | $X | X% | N | $X |
| plan | $X | X% | N | $X |
| build | $X | X% | N | $X |
| review | $X | X% | N | $X |
| **TOTAL** | $X | 100% | N | $X |

**C. Counterfactual: Opus-only cost**
- Apply Opus pricing ($15/M input, $75/M output) to ALL tokens across all phases

**D. Counterfactual: Phase-optimized cost**
- Opus for plan + review phases, Sonnet ($3/M input, $15/M output) for explore + research + build

**E. Summary table:**

| Approach | Cost | vs Actual |
|----------|------|-----------|
| Actual (multi-model) | $X | baseline |
| Phase-optimized (Opus plan/review, Sonnet rest) | $X | X.Xx vs actual |
| Opus only | $X | X.Xx vs actual |

**F. Cost-quality tradeoff assessment:**
- Did cheaper models in any phase miss things that a stronger model would have caught?
- Was the planning phase's model cost proportional to the value of its output?
- Were there build turns that were unnecessarily expensive or cheap?
- Could any explore/research turns have been skipped entirely?

---

### Step 3: Write the Audit Report

Write the audit report to: `.kimchi/audits/{auditFilename}`

Create the `.kimchi/audits/` directory if it does not exist.

**IMPORTANT — Write in chunks:** Do NOT attempt to write the entire report in a single tool call. Large writes can cause socket timeouts. Instead, write the report across multiple sequential tool calls:

1. **Write** the file with the header, summary table, and phase timeline (Step 3a)
2. **Append** the detailed findings for each dimension (Step 3b)
3. **Append** tool usage, improvements, and recommendations (Step 3c)

Use the following format, split across the writes described above.

#### Step 3a — Write header, summary, and phase timeline

Write a new file at `.kimchi/audits/{auditFilename}` containing:

```markdown
# Session Phase Audit: {sessionId}

**Session file:** {sessionFile}
**Date:** {session_start_timestamp}
**Duration:** {session_duration}
**Working directory:** {cwd}

## Audit Setup

| Parameter | Value |
|-----------|-------|
| Runner | {auditRunner} |
| Audit model | {auditModel} |
| Audit file | {auditFilename} |

## Summary

| Dimension | Grade | Key Finding |
|-----------|-------|-------------|
| Phase Discipline | X | one line |
| Architecture | X | one line |
| Code Quality | X | one line |
| Testing | X | one line |
| Phase-Model Alignment | X | one line |
| Cost Efficiency | — | $X actual ($X Opus-only = X.Xx savings) |

**Overall Grade: X**
(Weighted: Phase Discipline 15%, Architecture 20%, Code Quality 20%, Testing 20%, Phase-Model Alignment 10%, Cost Efficiency 15%)

## Phase Timeline

| # | Phase | Start | End | Duration | Model(s) | Turns | Cost |
|---|-------|-------|-----|----------|----------|-------|------|
| 1 | explore | HH:MM | HH:MM | Xm | model-id | N | $X |
| 2 | plan | HH:MM | HH:MM | Xm | model-id | N | $X |
| ... | | | | | | | |
```

#### Step 3b — Append detailed findings

Append to the same file. Write one section per dimension:

```markdown
## Detailed Findings

### Phase Discipline — Grade: X
**Strengths:**
- ...
**Weaknesses:**
- ...

### Architecture & Design Decisions — Grade: X
**Strengths:**
- ...
**Weaknesses:**
- ...

### Code Quality — Grade: X
**Strengths:**
- ...
**Weaknesses:**
- ...

### Testing Strategy — Grade: X
**Strengths:**
- ...
**Weaknesses:**
- ...

### Phase-Model Alignment — Grade: X
**Strengths:**
- ...
**Weaknesses:**
- ...

### Cost Analysis

(Full tables from Step 2.6)
```

#### Step 3c — Append tool usage, improvements, and recommendations

Append to the same file:

```markdown
## Tool Usage by Phase

| Tool | explore | research | plan | build | review | Total |
|------|---------|----------|------|-------|--------|-------|
| Read | N | N | N | N | N | N |
| Edit | N | N | N | N | N | N |
| Bash | N | N | N | N | N | N |
| ... | | | | | | |

## Top 3 Actionable Improvements

1. **[specific action]** — [why, expected impact]
2. **[specific action]** — [why, expected impact]
3. **[specific action]** — [why, expected impact]

## Model Usage Observations

- Which model performed well in which phase? Which underperformed?
- Any recommendations for model-phase assignment changes?
- Were there phases where model switching mid-phase caused context loss?

## Phase Workflow Recommendations

- Should the phase order have been different for this type of task?
- Were any phases skipped that should have been used?
- Were any phases used that added no value?
```

---

### Step 4: Per-Turn Model Attribution

Iterate every assistant turn (type: "message", role: "assistant"). Determine active model per turn by walking `model_change` entries in chronological order. The first assistant message after a `model_change` marks the start of that model's turns.

Output a table:

| Turn | Model | Provider | Duration (since previous turn) | Notes |
|------|-------|----------|-------------------------------|-------|
| 1 | model-id | provider | Xs | first turn |
| 2 | model-id | provider | Xs | |
| ... | | | | |

For the first turn of each model, annotate that this is a **switch boundary**.

---

### Step 5: Routing Decision Rationale

When a new model appears (model_change), look backward for the preceding assistant message that contains clues about why the switch happened (e.g. tool calls `Agent`/`set_phase`, deployment rules in system prompts, explicit orchestration text).

Record:

| Switch # | From | To | Trigger (phase, tool call, or explicit text) | Evidence (message ID or turn #) |
|----------|------|----|----------------------------------------------|--------------------------------|
| 1 | model-a | model-b | phase: plan | turn #4 |
| 2 | model-b | model-c | Agent delegation to kimi-k2.6 | turn #12 |

If no evidence is found, note "inferred from session bootstrap".

---

### Step 6: Switching Latency

Measure `switch_latency_ms` = timestamp(first assistant message after model_change) - timestamp(model_change entry).

Aggregate across all switches:

| Metric | Value |
|--------|-------|
| Mean latency | Xms |
| Max latency | Xms |
| Min latency | Xms |
| Total switches | N |

Per-model-pair breakdown:

| From | To | Count | Mean Latency | Max Latency |
|------|----|-------|--------------|-------------|
| model-a | model-b | 2 | Xms | Xms |
| model-b | model-c | 1 | Xms | Xms |

---

### Step 7: Subagent Lifecycle Metrics

Search for all `Agent` tool calls within assistant turns. For each, capture:
- The `turnIndex` when invoked
- The model delegated to (from tool arguments: `model` field)
- The `tokenBudget` requested
- Whether a `get_subagent_result` or `steer_subagent` appears later in the session (indicating lifecycle completion or intervention)

Count subagent loops: # of `Agent` calls that precede a `steer_subagent` for the same subagent.

Output table:

| Subagent # | Turn Invoked | Delegate Model | Budget | Looped? | Completed? | Context-Complete? |
|------------|-------------|----------------|--------|---------|------------|-------------------|
| 1 | 4 | kimi-k2.6 | 150000 | No | Yes | Yes |
| 2 | 12 | minimax-m2.7 | 200000 | Yes | Yes | No |

Definitions:
- **Looped**: a `steer_subagent` was sent to this subagent before it completed
- **Completed**: a `get_subagent_result` was received for this subagent
- **Context-Complete**: no `steer_subagent` was needed (subagent self-completed)

---

### Step 8: Token Consumption per Task Class

Map each assistant turn to a **task class** based on the dominant activity in that turn:

| Task Class | Detection heuristics |
|------------|---------------------|
| `explore` | `read`, `grep`, `find`, `ls` tool calls dominate |
| `plan` | `edit`/`write` of `.md` spec files, `set_phase("plan")`, or explicit planning tool calls |
| `build` | `edit`, `write`, `bash` (compilation / test execution) dominates |
| `review` | `lsp_diagnostics`, review comments, `set_phase("review")` |
| `research` | `web_search`, `web_fetch` calls |
| `orchestration` | `Agent`, `set_phase`, `start_ferment_step`, `complete_ferment_step`, `get_subagent_result` |

If a turn has mixed tools, classify by the most frequent tool family. If tie, prefer: orchestration > plan > build > review > research > explore.

Aggregate token usage per class across all turns and per-model:

| Task Class | Turns | Input | Output | CacheRead | CacheWrite | Total Tokens | Cost |
|------------|-------|-------|--------|-----------|------------|--------------|------|
| explore | N | X | X | X | X | X | $X |
| plan | N | X | X | X | X | X | $X |
| build | N | X | X | X | X | X | $X |
| review | N | X | X | X | X | X | $X |
| research | N | X | X | X | X | X | $X |
| orchestration | N | X | X | X | X | X | $X |
| **TOTAL** | N | X | X | X | X | X | $X |

---

### Step 9: Cost per Completed Task

A "task" is defined as a contiguous block of turns bounded by:
- A phase switch (set_phase to a different phase), OR
- A terminal outcome (all tests passing, human-explicit completion, or branch commit/push)

Compute cost per task = sum of `usage.cost.total` for all turns within the block.

Only count tasks that reach a terminal state (tests pass, user confirms done, branch commit/push, etc.).

Output:

| Task # | Label | Phase | Turn Range | Cost | Terminal State |
|--------|-------|-------|------------|------|----------------|
| 1 | fix-auth-bug | build | 3–7 | $X.XX | tests pass |
| 2 | add-tests | build | 8–14 | $X.XX | PR created |

If a task does not reach a terminal state, note "incomplete" and exclude from efficiency analysis.

---

### Step 10: OSS vs Non-OSS Utilization

Classify each model as OSS or non-OSS using this mapping:

| Model | Provider | OSS? |
|-------|----------|------|
| minimax-m2.5 | MiniMax | No |
| minimax-m2.7 | MiniMax | No |
| qwen3-coder-next-fp8 | Qwen | Yes |
| kimi-k2.5 | Kimi | No |
| kimi-k2.6 | Kimi | No |
| nemotron-3-super-120b | NVIDIA | Yes |
| claude-opus-4-6 | Anthropic | No |
| claude-sonnet-4-6 | Anthropic | No |

If a model is not in this table, classify it based on provider (Qwen/NVIDIA = OSS; others = non-OSS) unless you have specific knowledge.

Compute:
- **Token-based ratio**: (tokens sent to OSS models) / (total tokens)
- **Cost-based ratio**: (cost for OSS models) / (total cost)

Report both. Provide per-model breakdown:

| Model | OSS? | Input Tokens | Output Tokens | Total Tokens | Cost |
|-------|------|-------------|---------------|--------------|------|
| kimi-k2.6 | No | X | X | X | $X |
| qwen3-coder-next-fp8 | Yes | X | X | X | $X |

Summary:
- OSS token ratio: X.X%
- OSS cost ratio: X.X%

---

### Step 11: Write the JSON Sidecar

**Append** the following fenced JSON block to the audit report file (after the markdown content). This is the machine-readable sidecar for automated comparison between experiment runs. Write this as a separate append operation — do NOT combine it with any markdown write.

\`\`\`json
{
  "schemaVersion": "1.0.0",
  "sessionId": "{sessionId}",
  "timestamp": "<session_start_timestamp>",
  "modelsUsed": [
    {
      "modelId": "<model-id>",
      "provider": "<provider>",
      "turns": <count>,
      "tokens": { "input": <n>, "output": <n>, "cacheRead": <n>, "cacheWrite": <n> },
      "cost": <total-cost>,
      "isOss": <true|false>
    }
  ],
  "switches": [
    {
      "from": "<model-a>",
      "to": "<model-b>",
      "timestamp": "<iso-timestamp>",
      "latencyMs": <ms>,
      "rationale": "<trigger description>"
    }
  ],
  "subagents": [
    {
      "delegateModel": "<model>",
      "budget": <token-budget>,
      "looped": <true|false>,
      "completed": <true|false>
    }
  ],
  "taskClasses": {
    "explore": { "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "cost": 0 },
    "plan": { "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "cost": 0 },
    "build": { "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "cost": 0 },
    "review": { "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "cost": 0 },
    "research": { "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "cost": 0 },
    "orchestration": { "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "cost": 0 }
  },
  "completedTasks": [
    {
      "label": "<task-label>",
      "turnRange": [<start>, <end>],
      "cost": <cost>,
      "terminalState": "<state>"
    }
  ],
  "ossRatio": {
    "byTokens": 0.0,
    "byCost": 0.0
  },
  "aggregates": {
    "totalTokens": 0,
    "totalCost": 0,
    "totalTurns": 0,
    "totalSwitches": 0,
    "totalSubagents": 0,
    "errors": 0
  }
}
\`\`\`

After writing the JSON sidecar, say: "Audit complete for session {sessionId}. Report at .kimchi/audits/{auditFilename}"
