# Reversible redaction tokens

Token mode renders identifier detections (emails, IPs, phones, person and
URL spans) as stable per-session tokens (`[EMAIL_ADDRESS_1]`,
`[IP_ADDRESS_2]`) instead of `[REDACTED-EMAIL_ADDRESS]` markers in
everything the model and the session file see, and substitutes originals
back only at **presentation boundaries** — the TUI transcript and the ACP
stream. Marker mode remains the shipping default.

```json
{ "redaction": { "renderMode": "tokens" } }
```

## Semantics

- **Per-value stability.** Two mentions of the same address render as the
  same token for the whole session, so the model can correlate mentions
  (`[EMAIL_ADDRESS_1]` vs `[EMAIL_ADDRESS_2]`) instead of losing the
  distinction to a flat marker. That correlation is the point: the model's
  context keeps the value's identity without holding the value.
- **Identifiers only.** Token mode applies to `EMAIL_ADDRESS`,
  `IP_ADDRESS`, `PHONE_NUMBER`, `PERSON`, and `URL`. Every secret-class
  detection (credentials, keys, tokens) and every custom pattern stays
  marker-shaped in every mode — a vault holding live credentials would be
  strictly more dangerous than one holding identities, and coherence gains
  for secrets are nil.
- **Detection unchanged.** Token mode changes only rendering. What is
  found, what is excluded (`redaction.excludedEntities`), and what the
  precision defaults drop are byte-identical to marker mode. Telemetry
  tallies both shapes under the same entity key, so marker and token
  modes report indistinguishable counts.

## The vault

The token→original mapping is in-memory only, per session, deleted on
session shutdown. It is never written to session files, exports,
telemetry, crash artifacts, or logs, and no recoverable form of it ever
leaves the process. Copies of the originals nevertheless live in process
memory for the session's lifetime: a full core/crash dump of a live
token-mode process captures them (marker mode's in-memory window is
shorter). This is accepted, same class as the process's other in-memory
secrets.

Counters are process-global, deliberately: two live sessions can never
both hold `[EMAIL_ADDRESS_1]` for different values. A token from one
session is structurally unknown to every other vault, so cross-substitution
cannot return a wrong value — worst case it renders the token verbatim.

## Where originals exist

| Surface | Always (marker mode) | Token mode | Notes |
|---|---|---|---|
| Model/provider requests | markers | tokens | `before_provider_request` hook |
| Session files on disk | markers | tokens | `message_end` / `tool_result` hooks |
| Exports (`redact-copy`, strict walk) | markers | **markers, unconditionally** | tokens never reach exports; no opt-out |
| Telemetry (`pii_redaction.*`) | entity counts | entity counts | identical counts both modes |
| TUI transcript | markers | **originals** | `registerMarkdownTransformer` sees full text per repaint, stateless substitution |
| ACP `agent_message_chunk` stream | markers | **originals** | substituted server-side before emission; the client is the user's own IDE — same trust domain as the TUI terminal |
| Tool-result display panes | markers | tokens | not part of the paint path in v1 |
| Thinking blocks (visible) | markers | tokens | the patched thinking renderer does not substitute; collapse in v1 |
| After process restart | markers | tokens (viewport verbatim) | vault gone; degraded, never wrong |

## Failure modes (all degrade toward the token, never toward PII)

- No vault for a session (unknown id, markers mode, settings typo degrading
  to markers): redaction composes **markers** as today.
- Unknown or confabulated token (model hallucinated `[EMAIL_ADDRESS_42]`,
  vault gone, foreign-session token): rendered **verbatim** by
  substitution — substitution never crashes and never invents a value.
- Token split across stream deltas: ACP buffers only the
  shape-bounded tail (≤42 chars) until the token completes; a hostile
  `[AAAA…` flood falls out of the shape and streams through immediately.
- Settings validation failure (`renderMode: "manual"`): markers mode with
  one loud log; strict exports fail closed as for any broken redaction
  settings block.

## Compliance note

Marker-mode transcripts are close to anonymized. Token-mode ones are
**pseudonymized, not anonymized**: the transcript reveals occurrence
structure (how many distinct values, how often each appears) that markers
conceal, and equality plus context can re-identify a value in small sets.
Treat exported token-mode transcripts as personal data under GDPR framing,
per the table above — although exports revert to markers unconditionally,
a session file under token mode does not.
