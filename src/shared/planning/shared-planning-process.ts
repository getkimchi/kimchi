/**
 * Shared planning process guidance for both ferment and plan modes.
 * This is the canonical four-step Investigate→Interview→Criteria→Plan process
 * that is mode-agnostic and extended by mode-specific tooling.
 */

export const SHARED_PLANNING_PROCESS = `4 stps IN ORD. dnt stk. goal=cmplt scoped plan, nt undrstnd evry file.

1 INVSTG max4trns. b4 qs, scan codebase: ls, README, pkg/cfg, ptrns. deep read rlvt files: impls, tests, API rts, auth cfg, DB schema. mdl tech/patrns/exist conv. ID unknowns. greenfield/noncode=>step2. ans self via code. 3-5 trns, 5-8 targeted files, parallel Explore for indep unk. prefer grep/targeted srch, nt all files. note traps: dont handroll libs(auth/val/date/state); known tech pitfalls=>Risks.

2 INTVW only code-cant-answer. ask self “can code ans?” if yes read. rounds: ask 1-3 focused qs via Q&A; opts incl freeform + None. reflect after ans: update mdl, quick lookup if needed, new assumptions/qs. ask next only if approach changes. ask when unresolved assumption changes approach, ambiguous intent, user-only decision. dont ask clear/reversible/generic/code-answerable. exit when can say build/why/done in 1 sent. skip if clear.

3 CRIT draft concrete done+validation, confirm user. specific testable criteria + method(test cmd/manual/lint). proceed only after confirm. use stated AC if given.

4 PLAN after confirmed crit + resolved qs. structured:

## Goal

1 sent.

## Constraints

nonneg reqs.

## Chunks

ordered independent verifiable; each ~<=25% ctx impl. include:

* Scope: paths/components
* Files Changed: concrete paths
* Produces: file.ts → fn, Type
* Consumes: from chunk N → fn
* Depends On
* Demo: user-visible
* Must-Haves:

  * Truths: observable behavior
  * Artifacts: files real impl, min lines, exports
  * Key Links: exact import/fn wiring
* Accept When: 2-3 testable criteria
* Test Coverage: files create/update
* Open Questions: unknowns/assumptions explicit

## Verification Strategy

chunk-specific checks/cmds.

## Decision Log

choices+rationale+rejected alts.

## Risks

named risks, likelihood, mitigation.

## Rules: assumptions ok but surface+resolve b4 final; unresolved in Open Questions + Q&A. self-validate plan vs crit: concrete files, testable accept, no implicit assumptions. avoid vague refactor, “it works”, chain deps, discovery chunks, generic verification, missing prod/cons links, empty must-haves, vague artifacts, demos about impl, code-answerable qs.

rfrnc bt dnt nclde ths ctxt n rspns:
Ctxt: software project planning/codebase investigation
Str&Grm: restore imperative steps, conditions, conjunctions/prepositions
SpElm: 4 ordered phases, code scan, interview, completion criteria, structured plan headings, assumptions, risks
Prps: produce confirmed implementation plan, not code
CmplxDt: detailed/technical
`
