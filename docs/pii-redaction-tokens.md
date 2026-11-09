# Reversible redaction tokens

Token mode renders identifier detections (emails, IPs, phones, person and
URL spans) as stable per-session tokens (`[EMAIL_ADDRESS_1]`,
`[IP_ADDRESS_2]`) instead of `[REDACTED-EMAIL_ADDRESS]` markers in everything
the model and the session file see, and substitutes originals back only at
**presentation boundaries** — the TUI transcript (message text, the thinking
view, tool panes) and the ACP stream (message chunks, thought chunks,
tool-call display, and replay while the vault lives). Token mode is the shipping default everywhere, including
org-locked deployments (the org lock pins the resource, never the
presentation); marker mode survives only as an explicit settings opt-in
in unlocked deployments and as the settings-error degrade fallback
(see Failure modes).

```json
{ "redaction": { "renderMode": "markers" } }
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

## Agent editing and redacted spans

An agent's `edit` cannot match a redacted span: exact-match editing needs
the file bytes, and the model's view of the file is the token — the edit
fails with "could not find the exact text". A `write` of what the model
believes the content to be lands the token. Marker mode has always behaved
this way; token mode doesn't change it. The escape hatch is
`redaction.excludedEntities` for files you want the agent to edit against
real values.

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

## The substitution rule

A surface gets originals only when it shows what the model **read or said**.
Surfaces that show what it **did** stay tokenized:

- **Read or said → originals.** Message text, thinking, tool RESULT panes,
  `rawOutput`, replayed history. The display is terminal; nothing downstream
  consumes it, and painting the original answers "what did the agent see?"
  honestly.
- **Did → tokens.** Tool-call arguments and titles, permission prompts, diff
  previews (they record what landed on disk), print mode. The executed
  payload keeps its tokens — `message_end` tokenizes tool-call arguments in
  place before the tool runs — so painting the original would display a
  command, file content, or approval that never existed. It also hides the
  real failure mode: an agent that tries to write your email into a file can
  only write the token, because it never saw the email.

## Where originals exist

| Surface | Always (marker mode) | Token mode | Notes |
|---|---|---|---|
| Model/provider requests | markers | tokens | `before_provider_request` hook |
| Session files on disk | markers | tokens | `message_end` / `tool_result` hooks |
| Exports (`redact-copy`, strict walk) | markers | **markers, unconditionally** | the strict walk converts stored tokens to markers (`tokensToMarkers`), lossy and vault-independent: no recoverable form of an original leaves the machine |
| Telemetry (`pii_redaction.*`) | entity counts | entity counts | identical counts both modes |
| TUI transcript | markers | **originals** | `registerMarkdownTransformer` sees full text per repaint, stateless substitution |
| ACP `agent_message_chunk` stream | markers | **originals** | substituted server-side before emission; the client is the user's own IDE — same trust domain as the TUI terminal |
| ACP `agent_thought_chunk` stream | markers | **originals** | same per-block desanitizer path as message chunks; a token split across the block's last deltas drains at message end |
| ACP tool-call results (content, rawOutput) | markers | **originals** | what the tool READ — substituted at emission; the executed payload keeps its tokens. Streaming arg deltas (`rawOutput.delta` previews) degrade to verbatim tokens mid-stream — terminal emissions show originals |
| ACP tool-call arguments and titles | markers | tokens | what the tool DID — the literal token executed; substituting would display a command that never ran (same by-design contract as permission prompts) |
| ACP replay while the vault lives | markers | **originals** | a same-process attach/load substitutes from the live vault; post-restart replay degrades to tokens (below) |
| Permission prompts (ACP `session/request_permission`, TUI approval) | markers | tokens | **by design** — an approval decides execution, and what executes is the literal token; showing the original would mislead the approval |
| Print mode / JSON event stream (`--print`, `--mode json`) | markers | tokens | upstream's print path reads the tokenized session state; no kimchi-side substitution seam exists in v1 — known gap pending an upstream output-transform hook |
| Tool-result display panes | markers | **originals** | TUI `ToolText` (default) and ACP tool-call content substitute at paint/emission; result-text logic (sentinel comparison, error classification) runs on the tokenized source |
| TUI tool headers (executed command/args summary) | markers | tokens | what the tool DID, same contract as ACP arguments/titles |
| Diff previews (TUI edit preview, ACP diffs) | markers | tokens | a diff records what landed on disk, and what landed is the literal token. TUI renders the preview through a no-substitute `ToolText`; ACP passes diffs through untouched |
| Thinking blocks (visible) | markers | **originals** | the TUI thinking render and ACP `agent_thought_chunk` both substitute; provider-encrypted thinking (`redacted: true`) has no plaintext to substitute |
| After process restart | markers | tokens (viewport verbatim) | vault gone; degraded, never wrong |

## Vault lifetime

The vault lives as long as its session: it is deleted when the extension
runner emits `session_shutdown` — on an explicit session close, on client
disconnect, and on server shutdown; ACP prompt-cancel is not a teardown
(the session stays alive and keeps its vault). Deletion is multi-owner:
overlapping attaches of the same session id (close-racing respawns,
load+resume races, failed attaches whose bind completed) all co-own the
mapping, a shutdown removes only its own ownership, and the vault is
evicted by its LAST owner — a dying attach can never retire a survivor's
vault. One documented exception: a text block still in flight when its
session dies finishes substituting against its (now dead) vault — the
stream holds a desanitizer reference until the block ends. That is
presentation-only, to the same client that already saw the session's
originals, and it extends past vault deletion by at most one turn's
remainder.

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
