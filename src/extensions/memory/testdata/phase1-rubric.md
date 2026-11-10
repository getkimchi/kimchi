# Frozen fact classification rubric (Phase 1, verbatim semantics)

Frozen from `.kimchi/docs/clbench-step7-fact-grading.md` (2026-11-08). All later precision
comparisons (V2 vs Phase 1) must use THIS rubric, on run-level post-drain stores.

## Grading procedure

1. Collect the run's post-drain store facts (`memory list --scope <store>` output; artifact
   `facts` arrays are the frozen equivalent).
2. Classify EVERY stored fact into exactly one slot; partial credit is not allowed.
3. Count slots; rule precision = (A + B) / total. Report per-run and aggregate tables.

## Slots

- **A (rule)**: an exact schema mapping, unit/format convention, or processing decision that a
  future query could fail without. Test: swapping table/column names for generic words leaves a
  statement that is still actionable — "use X — blank/UNTRUSTED on ~N% of rows", "timestamps in
  this store are milliseconds", "`main_cat` uses value V rather than the literal name".
- **B (trap-style hint)**: a lesson like trap recognition or a CORRECTION decision with retained
  alternatives — credit only when the rejected alternative itself carries information
  ("use `main_cat`, rejecting the taxonomy-root reading (`cat_lvl=0`) as degenerate").
  Task facts usable across CONTINUING conversation types count; one-off results don't.
- **C (theory-ish)**: hypotheses, plan steps, or recommendations concerning future work
  ("worth checking", "should verify"). Neither rules nor noise; reported separately.
- **D (noise)**: anything else. THE key semantic rule **"A rule in the trap sense is
  time-to-value independent"**:
  a RANKING among recent assistants' outputs, an answer-level task conclusion or the assistant's
  own recap, and "the user is working on/with/in a …" task/conversation-context echoes are ALL
  D slot — regarded for memory purposes as what was never fact-shaped in the first place.
  Extractor self-references (e.g. "No durable facts about the user were found in this snippet.")
  are D and counted in the `extractor_meta_leak` class.

## Phase 1 grading outcome (frozen)

13/21 rules = **0.619 precision** (run_0000 2/3, run_0001 3/6, run_0002 8/12). Noise classes in
gated runs: 2 answer-level recalls, 5 session-framing echoes, 0 extractor meta-leaks
(meta-leak appeared only in the gates-off arm: 1 occurrence).
