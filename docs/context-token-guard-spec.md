# Context Token Guard Specification

## Problem Statement

AgentTimeoutError occurs when input contexts grow to 3M–9M+ tokens. Each turn re-sends the entire growing context, causing per-turn latency to increase monotonically. A 30-second turn becomes minutes, walltime is exhausted.

### Root Causes

1. **No turn-level input-token guard** — The harness doesn't measure cumulative input size per turn and trigger compaction.
2. **Tool outputs kept verbatim** — Large bash outputs are paid for on every subsequent turn.
3. **Subagent delegation doesn't shrink parent context** — Orchestrator still carries every prior turn.
4. **No session-rollover handoff** — No "checkpoint and start fresh" path for long tasks.

## Solution Architecture

### Phase 1: Turn-Level Token Measurement (`prompt-enrichment.ts`)

Add a lightweight token estimation function that runs before every LLM call:

```typescript
interface TokenMetrics {
  totalTokens: number
  messageBreakdown: Map<string, number> // message ID -> estimated tokens
  lastCompactionTurn: number
}

function estimateTokens(messages: Message[]): TokenMetrics {
  // Approximation: 1 token ≈ 4 characters for English text
  // More accurate: tiktoken or similar if available, else character-based
  const breakdown = new Map<string, number>()
  let total = 0
  
  for (const msg of messages) {
    const text = extractTextContent(msg)
    const tokens = Math.ceil(text.length / 4)
    breakdown.set(msg.id, tokens)
    total += tokens
  }
  
  return { totalTokens: total, messageBreakdown: breakdown, lastCompactionTurn: 0 }
}
```

### Phase 2: Context Compaction Strategy (`prompt-summary.ts` - Enhanced)

When token count exceeds thresholds, trigger aggressive compaction:

#### Thresholds
- **WARNING**: 500K tokens → Log warning, suggest compaction
- **COMPACT**: 750K tokens → Replace old tool results with summaries
- **EMERGENCY**: 1M tokens → Aggressive truncation of non-essential content

#### Compaction Rules (Priority Order)

1. **Tool Results (Lowest Priority)**
   - Bash outputs >10KB: Replace with `{displayOutput: "..."}` (already collapsed display)
   - File reads >50KB: Truncate body, keep first/last lines
   - Web fetch >100KB: Already truncated, but ensure only collapsed version kept

2. **Old Turns (Medium Priority)**
   - Turns older than N turns: Replace with `{"type": "compaction", summary: "..."}`
   - Keep tool calls but collapse their results to summaries
   - Always preserve: user prompts, final outputs, error states

3. **Subagent Results (High Priority for Compaction)**
   - Full subagent transcripts → One-line completion summary
   - Keep only the `subagent` tool call and its result summary
   - Strip all internal subagent messages

### Phase 3: Compaction Message Format

```typescript
interface CompactionMessage {
  type: 'context_compaction'
  customType: 'context_compaction'
  summary: string
  preserved: {
    userPrompts: string[]
    finalOutputs: string[]
    errors: string[]
  }
  metrics: {
    originalTurns: number
    compactedTurns: number
    originalTokens: number
    finalTokens: number
  }
  timestamp: number
}
```

### Phase 4: Integration Points

#### A. `prompt-enrichment.ts` - Add Token Monitoring

```typescript
// In the context handler or a new pre-llm handler
pi.on('before_llm_call', async (event) => {
  const metrics = estimateTokens(event.messages)
  
  if (metrics.totalTokens > COMPACTION_THRESHOLD) {
    const compacted = await compactContext(event.messages, metrics)
    return { messages: compacted.messages }
  }
  
  return { messages: event.messages }
})
```

#### B. `prompt-summary.ts` - Extend with Compaction Capability

Move from passive summary display to active compaction management:

```typescript
interface TokenGuardConfig {
  warningThreshold: number    // 500_000
  compactionThreshold: number // 750_000
  emergencyThreshold: number  // 1_000_000
  minTurnsBetweenCompactions: number // 5
  maxToolOutputSize: number   // 50_000 chars
}

class TokenGuard {
  private config: TokenGuardConfig
  private lastCompactionTurn = 0
  
  shouldCompact(turnCount: number, tokenCount: number): boolean {
    if (turnCount - this.lastCompactionTurn < this.config.minTurnsBetweenCompactions) {
      return false
    }
    return tokenCount > this.config.compactionThreshold
  }
  
  async compact(messages: Message[]): Promise<Message[]> {
    // Apply compaction rules in priority order
    let result = this.compactToolResults(messages)
    result = this.compactOldTurns(result)
    result = this.compactSubagentContexts(result)
    
    this.lastCompactionTurn = turnCount
    return result
  }
}
```

#### C. `loop-guard.ts` - Coordination

When loop-guard triggers, compact context before blocking:

```typescript
// In loopGuardExtension
pi.on('tool_call', (event) => {
  const check = guard.checkAndRecord(event.toolName, event.input)
  if (check.block) {
    // Trigger context compaction before blocking
    pi.sendMessage({
      customType: 'context_compaction_request',
      display: false,
      details: { reason: check.reason }
    })
    return { block: true, reason: check.reason }
  }
})
```

### Phase 5: Bash Collapse Enhancement

Current `bash-collapse.ts` only affects display. Ensure collapsed content is also stripped from context:

```typescript
// In renderResult, when isToolExpanded is false
// The display is already collapsed, but we need to ensure
// the actual message stored in session is also truncated

// Option 1: Store displayOutput in message.displayOutput
// Option 2: Truncate the content field directly
```

## Implementation Files

### New File: `src/extensions/context-compactor.ts`

Core compaction logic separate from summary display.

### Modified Files

1. **`src/extensions/prompt-summary.ts`**
   - Add `TokenGuard` class
   - Register `before_llm_call` handler
   - Implement compaction logic

2. **`src/extensions/prompt-enrichment.ts`**
   - Add token estimation
   - Wire compaction trigger

3. **`src/extensions/bash-collapse.ts`**
   - Ensure collapsed content affects context size

4. **(Optional) New Event Type**: `before_llm_call` or use existing `context` event

## Testing Strategy

1. **Unit Tests**:
   - Token estimation accuracy
   - Compaction rule application
   - Threshold triggering

2. **Integration Tests**:
   - Long-running task simulation
   - Verify context size stays bounded
   - Verify task completion still possible

## Success Metrics

- Context size stays below 1M tokens for all benchmark tasks
- No `AgentTimeoutError` due to context growth
- Task success rate maintained (no loss due to missing context)

## Affected Trials (Expected Fix)

- make-mips-interpreter (~9.1M tokens)
- crack-7z-hash (~5.7M tokens)
- feal-linear-cryptanalysis (very large)
- train-fasttext (very large)
- And 10 others hitting timeout
