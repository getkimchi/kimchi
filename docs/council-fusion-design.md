# Council: Fusion Design

Council answers a turn by having several models solve the same task independently, comparing their
solutions, and writing a final patch or answer from that comparison. It follows the shape OpenRouter
[Fusion](https://openrouter.ai/docs/guides/features/plugins/fusion) established, adapted for an agent
that both edits files and answers open-ended questions.

Companion docs: [council.md](council.md) (model contract, presets, configuration),
[council-fusion-plan.md](council-fusion-plan.md) (implementation plan).

## 1. The Fusion shape

Fusion's pipeline, in its own words: "a panel of models answers your prompt in parallel, an analyst
compares their responses and returns structured analysis." The analyst "doesn't merge them" — it
returns JSON describing **consensus** (points all or most models agree on, treated as
higher-confidence), **contradictions**, **partial coverage**, **unique insights** from individual
models, and **blind spots** none addressed. Your own model then writes the final answer from that
analysis.

Three properties define it, and Council preserves all three:

1. **Independent parallel generation.** Panel members never see each other's work. Diversity of
   solutions is the mechanism; a reviewer reading someone else's draft anchors on it and finds only
   small faults, while two independent attempts expose the large disagreements.
2. **Compare, don't merge.** The analyst classifies agreement and conflict rather than blending text.
   Agreement across independent attempts is itself the confidence signal.
3. **The context-holding model writes the answer.** Final authorship stays with the model that holds
   the session, so the answer keeps the conversation's voice and constraints.

Fusion has no critique stage, no judge, and no revision loop — deliberation is single-pass. Their
published result on 100 deep-research tasks: two models fused scored 69.0% against 65.3% for the best
single model, a budget panel beat larger solo models, and the *same* model paired with itself gained
6.7 points. That last number is the important one: the gain comes from having more than one
independent attempt, not from model diversity.

When the turn is a text answer, Council's pipeline is Fusion's, unmodified — the synthesized answer
is the message returned to the user, exactly as Fusion returns its own answer. Council adds exactly
one thing on top of that, for the turn shape Fusion never had to handle: when the objective is a code
change, the final artifact is a patch instead of text, so it is staged, applied atomically, checked,
and rolled back on failure rather than simply returned.

## 2. Pipeline

```text
kimchi/council[-fast|-deep]  (virtual provider)
          |
          v
  lead explores the repo (host agent loop, read tools)
          |
          | this turn's answer: a code change, or text
          |
          +---------------------------+-----------------------------------+
          | code change                                text
          v                                                     v
   (staged; triage below                          warrants deliberation?
    decides trivial vs reviewed)                    (request and answer
          |                                          both substantial)
          |                                                | no
          |                                                v
          |                                  lead answers directly, streamed
          |                                                | yes
          v                                                v
  freeze context: files read this turn + objective + constraints   (identical compiler either way)
          |                                                |
          v                                                v
  PANEL — N solvers in parallel, same context, none sees the others
     lead's own patch/answer  +  solver 2  +  solver 3  ...
     each emits a complete patch, or a complete standalone answer, as structured output
          |                                                |
          v                                                v
  ANALYST — compares the N patches, or the N answers
     consensus / contradictions / partial coverage / unique insights / blind spots
          |                                                |
          v                                                v
  SYNTHESIS — lead writes the final patch      SYNTHESIS — lead writes the final answer
     from the analysis                            from the analysis
          |                                                |
          v                                                v
  stage into ChangeTransaction -> apply         synthesized answer returned, buffered
    -> catalog checks -> settle                 (no transaction opens)
          |
          +-> rollback on failure
```

The lead's own patch or answer counts as one panel member: it is produced from the same frozen
context, before any other solution is visible, so it satisfies the independence property while
costing nothing extra.

### Stage detail

**Exploration.** The lead runs through the host agent loop with read tools and gathers what it needs.
This stage is unchanged from ordinary model operation.

**Deliberation decision.** Not every turn is worth N+2 model calls. For a code change, triage happens
after a candidate exists (see below). For a text answer, one function —
`shouldDeliberateCouncilAnswer` in `review-policy.ts` — decides after the lead has answered, using
the substance of the request and the length/structure of the lead's answer; below the bar, the lead's
answer returns immediately, exactly as a direct answer does today. Because that decision needs the
lead's answer, a request substantial enough that deliberation remains possible
(`mayDeliberateCouncilAnswer`, the same bar checked on the request alone) also disables live streaming
of the lead's own call up front — the final answer for a deliberated turn is the synthesis, not the
draft, and a draft streamed live cannot be un-shown once it clears the bar.

**Context freeze.** Everything the lead read this turn is compiled into one evidence packet:
objective, constraints, file contents, command output. Redaction is fail-closed and byte bounds apply.
Every panel member receives this identical packet — this is the "same reading material" property.
Nothing about one solver's work reaches another. The compiler is the same function on both branches;
a text turn simply carries no candidate patch artifact.

**Panel.** N solvers run concurrently. On the code path, each produces a complete patch as structured
output: a list of file operations (create, update, delete, rename) with full new content for changed
files — full content rather than diffs, since applying a model-authored diff is ambiguous and applying
full content is not. On the text path, each produces one complete standalone answer as structured
output, `{"answer": "..."}`. Either way, solvers have no tools and see only the frozen context.

**Analyst.** On the code path, receives the objective and all N patches rendered as diffs against the
real base (diffs computed locally, not by a model), and emits the five Fusion buckets plus the
validation checks the change warrants. On the text path, receives the objective and all N answers
anonymized and hash-seeded-shuffled the same way, and emits the same five buckets —
`required_checks` keeps its place in the schema but is always empty, since there is nothing to
validate. Either way it compares; it does not write code or a new answer.

**Synthesis.** The lead receives the analysis and the candidates, and writes the final patch or the
final answer in the same schema the panel used. Consensus regions are the safe core; contradictions
are where it must choose and say why; unique insights are what it should fold in. A patch is staged
into the transaction as the single candidate; an answer is the message returned to the user directly
— no transaction opens for a text turn, nothing is staged, and apply/rollback/settlement and the
mutation guard are never touched.

**Apply and verify.** The staged patch goes through the existing path: base bytes verified, applied
atomically, catalog-derived checks run (test/typecheck/lint/build discovered from project metadata),
settle on success, roll back on any failure. A workspace with no discoverable checks applies with a
`no_validation_checks` degraded reason rather than failing. A synthesized text answer has no apply
step; it is delivered as one buffered message.

## 3. Presets

Panel size is the only real cost dial, so it is what the presets set — for a code turn and for a
deliberated text turn alike.

| Model | Panel | Analyst | Synthesis | Calls per deliberated turn |
| --- | ---: | --- | --- | ---: |
| `kimchi/council-fast` | 2 (lead + 1) | combined with synthesis (code only) | — | ~3 |
| `kimchi/council` | 3 (lead + 2) | separate | separate | ~5 |
| `kimchi/council-deep` | 5 (lead + 4) | separate | separate | ~7 |

A trivial code candidate, or a text turn that does not clear the deliberation bar, costs one call at
every preset. Panel membership and size are overridable through configuration; the presets are
defaults, not ceilings on what can be configured.

## 4. What Council deliberately does not do

- **No critique stage.** No model reads another's patch or answer in order to find fault with it. The
  analyst compares finished solutions; that is the entire quality mechanism before the result ships.
- **No judge dispositions.** There is no per-finding bookkeeping, no upheld/resolved verdicts, and
  nothing that must be dispositioned exactly once.
- **No revision loop.** The synthesis is the final patch or answer. If a patch's checks fail, it rolls
  back and the turn reports the failure; neither branch re-enters the pipeline.
- **No per-model repo exploration.** Solvers receive context; they do not gather it. This keeps a turn
  at one call per solver.
- **No merging of patches or answers.** The analyst never blends diffs or answers, and synthesis
  produces one coherent result rather than a union of others.
- **No transaction for text.** A deliberated text turn opens no `ChangeTransaction`, stages nothing,
  and runs no validation check — `required_checks` is preserved in shape but always empty and never
  resolved.

## 5. Invariants

- Panel members are dispatched from the same frozen packet and cannot observe each other.
- Solver and analyst output is structured, schema-validated, repairable once, and never persisted or
  shown to the user; only the synthesized public message is returned.
- Diffs shown to the analyst are computed by the runtime from base bytes, never authored by a model;
  the text path's analyst compares raw answers the same way, with no diff involved.
- The real workspace is untouched until synthesis produces a patch that passes apply-time base
  verification. A text turn never touches the workspace at all.
- Validation commands come only from the deterministic project catalog, resolved by ID; models never
  supply shell commands; the text path resolves none.
- Failure at any stage before apply leaves the workspace unchanged; failure after apply rolls back. On
  the text path, failure at any stage after the lead has answered returns the lead's own answer with a
  degraded reason instead of failing or returning nothing.
- Council models never resolve to Council models — recursion is rejected at model resolution.
- Budgets (wall-clock deadline, aggregate tokens, concurrency) bound the whole turn and persist across
  the tool rounds of a single user turn.
