# Prior art: memory consolidation / "dreaming" systems

**Research date:** 2026-11-06 · compiled from web research during the
memory-dreaming planning discussion. Companion to
`.kimchi/plans/memory-dreaming.md`.

## Shipped product systems

### OpenAI ChatGPT "Dreaming" — direct match for the term and concept
- Timeline: Apr 2024 "saved memories" (in-conversation writes, strong
  trigger cues, go stale) → **Apr 2025 dreaming V0** (background process that
  curates memory by referencing chat history) → **2026 "Dreaming V3"**
  (memory = synthesized "memory state"; ~5× serving-compute reduction;
  upgraded from supplementing saved memories to the foundation layer).
  Source: <https://openai.com/index/chatgpt-memory-dreaming/> (June 4, 2026)
- Design notes: memories synthesized by dreaming are user-reviewable on a
  "memory summary" page (correct/dismiss); eval axes are behavioral:
  carry-forward context, preference-following, **staleness over time**
  ("going to Singapore in July" → "went to Singapore in July 2026").
- Mechanism is undisclosed (no clustering/geometry details published).

### Letta — sleep-time compute + "Dreaming" setting
- Paper: Sleep-time Compute (arXiv 2504.13171) — agents reason offline over
  context during idle time; ~5× test-time compute reduction on stateful
  benchmarks; efficacy correlates with *query predictability*.
- Product: two-agent split (primary + background sleep-time agent that
  rewrites memory/MemFS); CLI literally has a "Dreaming" setting
  (`/sleeptime`; run after N steps or on compaction; optional
  review-before-apply pass).
  Sources: <https://www.letta.com/blog/sleep-time-compute/>,
  <https://docs.letta.com/configuration/memory/>

### LangChain LangMem — background consolidation, debounced
- `create_memory_store_manager` consolidates conversation → memory
  collection in background; `ReflectionExecutor` debounces (delay, cancel,
  reschedule) before synthesis; memory ops can insert/update/delete
  (enrichment loop). No clustering — LLM reconciles against retrieved
  candidates. <https://langchain-ai.github.io/langmem/>

### Zep / Graphiti — temporal KG + community summarization
- Bi-temporal facts (`valid_at/invalid_at`, system vs world clock);
  contradiction resolution = explicit invalidation (kept, not deleted).
- **Communities**: label propagation over the entity graph → LLM
  hierarchical pairwise summarization into `CommunityNode`s (inspired by MS
  GraphRAG Leiden communities). Closest existing analog to
  "cluster → condense", but clustering is graph-structural, not
  embedding-space. <https://help.getzep.com/graphiti/core-concepts/communities>
- Cross-user seam exists: `group_id` shared graphs.

### Mem0 (the store Kimchi builds on)
- ADD-only extraction today (both versions kept on change; no silent
  rewrite); dedup = hash + retrieval-context check; paper variant had
  LLM-chosen ADD/UPDATE/DELETE/NOOP. No dreaming/consolidation pass in OSS —
  Kimchi's `memory consolidate` + this spike sit *above* what Mem0 provides.
  <https://docs.mem0.ai/core-concepts/how-it-works>

## Academic systems

- **Generative Agents (Park et al. 2023, arXiv 2304.03442)** — canonical
  "reflection": importance-threshold trigger → LLM picks focal questions →
  retrieve related records → synthesize higher-level insights with evidence
  pointers, stored back in the stream. Selection by recency×importance×
  relevance — **not geometric clustering**.
- **A-MEM (arXiv 2502.12110)** — Zettelkasten: each new memory becomes a
  structured note; LLM links to similar historical notes via similarity
  search; notes *evolve* (attributes updated as connections form). Linking
  is pairwise nearest-neighbor, not cluster-level synthesis.
- **HippoRAG (NeurIPS'24)** — hippocampal indexing theory: OpenIE triples
  → KG → Personalized PageRank for one-step multi-hop retrieval. Focus is
  retrieval associativity, not synthesis of new memories.
- **Surveys**: "Rethinking Memory in LLM-based Agents" (arXiv 2505.00675)
  names six memory operations — Consolidation, Updating, Indexing,
  Forgetting, Retrieval, Condensation — useful taxonomy; consolidation is a
  recognized operation, typically summarization-at-write-time.

## Adjacent pattern outside agent memory: "cluster embeddings → LLM summarize"

The geometric operation itself exists — but in retrieval indexing and
analytics, never as a memory-formation mechanism:

- **RAPTOR** (Sarthi et al., ICLR'24, arXiv 2401.18059) — embed chunks →
  UMAP → GMM soft clustering (BIC picks k) → LLM-summarize each cluster →
  re-embed summaries → recurse into a tree; collapsed-tree retrieval fills
  budget by cosine across levels. Exactly "cluster in embedding space →
  condense each cluster into higher-level text, recursively" — for RAG
  indexes: no truth-judging, no geometric verification of summaries,
  summaries are index nodes only.
- **Anthropic Clio** (arXiv 2412.13678) — facet extraction → embed facets →
  k-means cluster → LLM title+summary per cluster → hierarchy; privacy via
  **k-anonymity minimums** (clusters below ~1000 users suppressed) + a final
  model check that summaries carry no identifying detail. Direct precedent
  for our cross-user k-anonymity gate, in production at Anthropic scale.

**Inside memory systems, embeddings are used only pairwise (as an index):
lookup, dedup-blocking, nearest-neighbor linking — never analyzed as a
space.** The clustering that exists (Graphiti communities, GraphRAG) runs
over graph structure (label propagation / Leiden on graph edges), and
quality decisions are delegated to generative LLM judges. Centroids,
dispersion, silhouette, acceptance bands — absent everywhere we looked
(published work + OSS as of 2026-11-06; OpenAI dreaming internals are
undisclosed).

## Gap analysis: which of our components exist elsewhere?

| Component | Found elsewhere? |
|---|---|
| Background "dream" process synthesizing memory | ✅ OpenAI dreaming, Letta sleep-time, LangMem — productized |
| LLM synthesis of higher-level facts w/ evidence links | ✅ Generative Agents reflection (canonical) |
| "Group → condense into topic fact" | ✅ Graphiti communities (graph clustering, not embedding-space) |
| **Embedding-space-first discovery** (cluster the fact store itself, HAC/kNN + silhouette/coherence gates) | ❌ not found — existing systems select by salience, graph structure, or recency |
| **Geometric verification of synthesized facts** (landing band vs cluster scatter; paraphrase ceiling; three-zone insider/penumbra/off-topic read) | ❌ not found — nobody publishes embedding-space acceptance tests for synthesized memories |
| **Calibrated per-candidate judging** (d3: entailed/plausible/unsupported with probabilities) | ❌ unusual — others use generative LLM judges, no calibrated probabilities |
| k-anonymized **cross-user** synthesis (counts-not-names provenance) | ❌ not found (Graphiti group_id shares stores but with no k-anonymity synthesis layer) |
| Eval = holdout replay against future captured facts | ~ OpenAI evals are behavioral/response-level; LongMemEval is the public-benchmark flavor — our live version is standard in spirit |
| Staleness/time-updating | ✅ Graphiti bi-temporal, OpenAI dreaming staleness evals, our supersede |

## Read for the spike plan

The concept is validated at the largest possible scale (OpenAI credits
dreaming with a "step-function improvement" and made it the foundation
layer; Letta ships it). **Our differentiators live exactly where the
literature is quiet: embedding-space discovery, geometric verification,
calibrated judging, and the cross-user k-anonymity gate.** The spike's
metrics should emphasize these rather than re-proving that LLM synthesis
works.
