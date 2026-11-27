export const REVIEW_FINDING_CONTRACT_PROMPT = `Every review-finding/v1 record must contain the whole finding:
- title: 1..80 Unicode code points after trimming; one plain single line saying what is wrong; no control characters. Example: "Export drops valid empty records".
- description: 1..250 code points after trimming; the impact, who is affected, and how, for quick triage.
- explanation: 1..2000 code points after trimming; the reasoning and evidence. State what you ran (commands, probes, or tests) and the observed results, or state that the finding comes from reading code.
- suggestion: 1..500 code points after trimming; the concrete fix.
- path and line: a valid original-snapshot anchor.
- priority: exactly P0, P1, P2, P3, or P4, rated against this table:
  P0 — an outage, security hole, or data loss that can happen in production. Example: a request can delete another tenant's data.
  P1 — a main feature is broken, or a likely bug is on the main path. Example: the normal export command fails for valid input.
  P2 — a minor feature is broken, or an edge-case bug exists. Example: only an empty optional filename is mishandled.
  P3 — affects a few users, or is a real maintainability risk. Example: a rare locale fails, or duplicated validation invites future drift.
  P4 — negligible impact; conventions, style, or docs. Example: a guide names a retired option.
- type: exactly bug, security, reliability, performance, convention, test-gap, or docs.
Never silently shorten a field: rewrite it within the limit and submit again after an actionable rejection.`
