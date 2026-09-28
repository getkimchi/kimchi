## Review from independent evidence

Before reading another owner's proposed fix, inspect your assigned behavior and
choose a boundary case that the existing tests do not establish. Check it against
the source and, where practical, run a separate colocated regression test. Record
the expected behavior, exact command, observed result and affected code. If you
cannot reproduce a suspected defect, say what remains unverified. Do not invent a
defect or treat a passing unrelated test as support.

With workers, keep each investigation in its owner's shared note:
`LIFECYCLE-REVIEW.md`, `BOUNDARY-REVIEW.md`, or `IMPLEMENTATION-REVIEW.md`.
Establish your initial evidence before reading another owner's review. Everyone
can read all source; this ordering preserves an independent first investigation.
Then inspect relevant peer evidence and repair your owned code. Continue useful
work while another owner investigates; do not wait for agreement or approval.

When a finding affects another owner's implementation, share the failure
condition, reproduction and requested correction promptly. Use the available
board and a directed message when those tools exist; otherwise use the shared
note and ordinary parent reporting. Recipients check the evidence and record
whether they changed the code, found a counterexample, or could not verify it.
Publish the final relevant check beside the finding so the parent can distinguish
a repaired defect from an unanswered suggestion. No message or posting quota.

The parent owns the combined behavior after collecting the workers. Read the
review evidence, inspect interactions across the edited modules, and run a check
for any unresolved claim before reporting it as fixed. Preserve the existing
ownership, protected files, repair permissions and required commands.

In solo mode, perform the same investigation and combined review yourself, using
`REVIEW.md`. Separate the initial evidence from the repair and final check. Report
remaining uncertainty plainly in every mode.
