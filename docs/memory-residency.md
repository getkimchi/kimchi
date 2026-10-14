# Session memory: disk-backed residency and UI display budget

Large coding sessions can hold most of their conversation content in RAM as
JSC strings (measured ≈ 90% of the live heap on big sessions). This document
describes how Kimchi bounds that residency **without ever changing what the
model sees** — model-visible request context and resumed content stay
byte-identical to a session that never externalized anything.

## Invariants (non-negotiable)

1. **Agent quality**: nothing that reaches `before_provider_request` (or any
   other model-visible surface) is truncated, marked, or dropped. Lazy markers
   are hydrated back to the full bytes before a request leaves.
2. **Resume**: the session log (JSONL) always contains the **full content** of
   every message and tool result, unchanged. Disk mirror files are a secondary
   cache; resume never depends on them. (Enforced by the
   pi-coding-agent `_serializableEntry` patch.)
3. **Compaction stays context-driven** (upstream, token-based). Memory is not
   a compaction trigger.

## How it works

At write time, content above a threshold is **mirrored to disk** and the
in-memory message carries only a compact marker (`[kimchi-ext:tool]{file,
offset, length}`). The big string is never a long-lived JSC string — reads
materialize it transiently (bounded LRU cache) and release it.

| Surface | Behavior |
|---|---|
| `tool_result` | oversized tool output → marker (content-replacement result) |
| `before_provider_request` | markers hydrated to full content (byte-identical); the walk is shape-agnostic over the provider-native payload, so nested tool-result blocks (anthropic `tool_result.content`, gemini `functionResponse.response.output`, openai-responses `function_call_output.output`) hydrate the same as flat shapes; when the mirror is gone, hydration falls back to the session log (by toolCallId) before leaving a marker |
| Session log | full content always (pi patch resolves markers at serialization; at rewrite it restores from the log itself, so the invariant holds even if the mirror is gone) |
| TUI display | every result renderer is wrapped (`withMarkerResolution`) — markers resolve to mirrored content (or a mirror-gone caption) at render time, transiently; the raw marker never reaches the transcript |
| ACP client | `toolResultContent` and the wire `rawOutput` resolve markers before any `tool_call_update` leaves — the IDE never receives raw marker text (e2e-pinned) |
| `/memory-residency` | shows mirror bytes, resident cache size, entry counts |

Messages with tool calls, images, or thinking blocks are never externalized
(lossless-only rule). The mirror uses range reads (`fs.readSync` at an
offset); mmap is a tracked spike.

## Knobs (environment)

- `KIMCHI_TOOL_OUTPUT_STORE=off` — disable externalization entirely (today's
  behavior).
- `KIMCHI_TOOL_OUTPUT_EXTERNALIZE_BYTES` (default `65536`) — content above
  this many bytes is externalized.
- `KIMCHI_TOOL_OUTPUT_CACHE_BYTES` (default `16777216`) — resident read-cache
  budget; entries larger than the budget are read directly without caching.

## Measuring

The measurement harness lives in `.kimchi/docs/` (not committed by design):
`acp-memrepro.ts` (300-message growth), `acp-tooloutput-check.ts` (big tool
outputs + session-log invariant), `cdp-heap-dump.ts` + `analyze-heap.ts`
(live-heap strings, retained chains via the ACP-mode inspector — TUI
inspector commands hang, so TUI is spot-checked with `vmmap`).

Baseline: 300 × 2 MiB messages → live heap 698 MiB, strings 616 MiB pinned by
the session store. With externalization, oversized content lives on disk and
residency tracks the recent context + cache budget.


## History residency (compaction)

After a compaction commits, pre-compaction message entries' content is evicted
from memory: the in-memory `content` becomes a compact `[kimchi-ext:log]`
marker (a byte-offset reference into the session JSONL), and the full text is
read back on demand — display, ACP replay, and any consumer see the original
blocks transparently (bounded LRU keeps active scrolling cheap). The session
log is never rewritten; it remains the durable source of truth.

The TUI transcript renders the full leaf path (`buildDisplayEntries`), so
history stays scrollable after compaction while its content lives on disk.
Small messages (under ~256 chars) and post-compaction entries stay resident.
Eviction is in-memory only; resume re-hydrates from the log, and the first
compaction in a resumed session evicts the pre-cut history again.

**Known follow-ups**: scroll-driven windowed rendering (deferred — the pi-tui
ScrollView renders its whole child each frame, so virtualization needs upstream
layout work), resident-cache observability for evicted entries.


## Adaptive GC

The above mechanisms bound *content*; long sessions also accumulate transient
garbage (streamed output, request serialization, render churn) that JSC's
lazy collector never reclaims without memory pressure — measured: a 45-minute
dev session held 383 MiB of JSC heap for 181 KiB of live session content, with
a 1.5 GiB peak.

Two collection paths (`src/extensions/adaptive-gc.ts`):

1. **Idle**: after the agent is idle for a delay (default 120 s), one full
   `Bun.gc(true)`.
2. **Growth**: during long uninterrupted runs, message boundaries check RSS
   growth above the post-GC baseline (default 128 MiB) and collect when
   crossed — time-throttled to at most one growth collection per 30 s.
   Checks run on `message_end` (between messages, never mid-stream); a full
   collection is ~10–40 ms on a ~100 MiB heap.

Cross-session safety: `Bun.gc(true)` is stop-the-world, and a long-lived
process (the ACP server) can host several sessions. Every collection is
gated on "no other session has a request in flight" (a module-level
active-agent registry), and idle timers are `unref()`ed so they never hold
the event loop open.

Knobs: `KIMCHI_IDLE_GC=off` (disable), `KIMCHI_IDLE_GC_DELAY_MS`,
`KIMCHI_GC_GROWTH_BYTES`, `KIMCHI_GC_MIN_INTERVAL_MS`.

## Known follow-ups

> ACP coverage: the `sessionEntryToContextMessages` read seam is unit-tested
> (byte-exact resolution of both marker types), live tool results are covered
> end-to-end by `tests/e2e/acp/tool-output-externalization.test.ts` (the
> client never receives marker text and gets the real output). A dedicated
> ACP e2e for history replay of evicted (pre-compaction) sessions remains a
> follow-up; that path reads through the same patched seam as the TUI.

> Docs copy-resources: `scripts/copy-resources.js` has no `docs/` path and
> no runtime code references this file; `/docs` changes are exempt from the
> copy-resources pairing.

- Assistant/user-message externalization is **deferred**: a write-time
  `message_end` replacement was found to break live turns (the turn never
  completes after the content is replaced), so it was reverted. It needs an
  upstream content hook that does not disturb the stream pipeline.
- Mirror co-location with the session file. Largely mitigated: rewrites
  restore from the log itself and payload hydration falls back to the log
  (by toolCallId) when the tmpdir mirror dies, so a lost mirror no longer
  degrades the model-visible content. Co-location would still remove the
  fallback's scan cost and the ms-scale first-persist window; it needs
  per-session store lifecycle for ACP multi-session correctness.
- "Expand full content" UI affordance in the transcript/tool panes.
- ACP ext-method mirror for residency stats (`_kimchi.dev/memory_residency`).
- True mmap accessor spike.
- User-prompt externalization (no upstream content-replacement hook exists
  for user messages yet).