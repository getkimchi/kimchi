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

Token mode edits work: `edit` and `write` dereference vault tokens at
execute time (see The substitution rule), so an `oldText` of what the model
saw matches a file holding the original, and a `write` lands real bytes. The
model never sees the PII while moving it.

Marker mode stays uneditable by design: exact-match editing needs bytes the
model never receives, and there is no vault to dereference. A "Could not
find" failure there gains a note naming the cause and the escape hatch,
`redaction.excludedEntities` in settings.json (or disabling redaction for
the session). The same note fires in token mode when the span is a literal
unknown token or the vault is gone.

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

Display mirrors execution, card for card. A surface shows exactly the bytes
the underlying action runs or lands — no more, no less:

- **Local file mutation dereferences at execute time** (`edit`, multi-edit,
  `write` — the `EXEC_DEREF_TOOLS` allowlist in vault.ts): the model's
  tokens are substituted back to originals in the transient execution copy,
  so an edit whose `oldText` carries `[EMAIL_ADDRESS_1]` matches a file
  holding the real address, and a `write` lands the real bytes. This is the
  standard agent-harness pattern (Cover, Veil, PrivAiTe, privacy-proxy):
  local actions run with real values inside the local trust boundary; the
  privacy wall is the model's context, not the user's own filesystem. Cards,
  diff previews, and permission prompts for these tools therefore show the
  ORIGINAL — that is what executes.
- **Everything else executes byte-faithfully.** `bash`, MCP tools, agents,
  and any non-allowlisted tool runs its literal tokenized args (message_end
  tokenizes tool-call arguments in place). Their cards, headers, and
  permission prompts show the token — painting the original there would
  display a command that never ran. This allowlist-plus-passthrough shape
  keeps unknown and networked tools from ever receiving originals, so no
  deref path can route PII into outbound traffic.
- **A dead or absent vault changes both sides at once.** Markers mode, a
  post-restart replay, or redaction-off: execution cannot dereference, and
  every display renders tokens verbatim. The display and the file stay
  truthful in the degraded state too.

A planted token-shaped string in untrusted content (a malicious repo file
saying `[EMAIL_ADDRESS_1]`) can only resolve against THIS session's live
vault; it can cause the corresponding real value to be written into a LOCAL
file via edit/write — never into bash, MCP, or any outbound channel.

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
| ACP tool-call arguments and titles — edit/write | markers | **originals** | mirrors execution: these tools deref at execute time (EXEC_DEREF_TOOLS) |
| ACP tool-call arguments and titles — bash/MCP/other | markers | tokens | byte-faithful execution; the literal token is what ran |
| ACP replay while the vault lives | markers | **originals** | a same-process attach/load substitutes from the live vault; post-restart replay degrades to tokens (below) |
| Permission prompts — edit/write (ACP `session/request_permission`, TUI approval) | markers | **originals** | an approval decides execution, and execution derefs: the original is what lands |
| Permission prompts — bash/MCP/other | markers | tokens | an approval decides execution, and what executes is the literal token |
| Print mode / JSON event stream (`--print`, `--mode json`) | markers | tokens | upstream's print path reads the tokenized session state; no kimchi-side substitution seam exists in v1 — known gap pending an upstream output-transform hook |
| Tool-result display panes | markers | **originals** | TUI `ToolText` (default) and ACP tool-call content substitute at paint/emission; result-text logic (sentinel comparison, error classification) runs on the tokenized source |
| TUI tool headers — edit/write | markers | **originals** | mirrors execution (deref at execute) |
| TUI tool headers — bash/other | markers | tokens | byte-faithful execution |
| Diff previews (TUI edit preview, ACP diffs) | markers | **originals** | the diff records what landed on disk, and edit/write execution lands the dereferenced original. ACP substitutes diff items from a live vault; the TUI edit preview paints through the substituting `ToolText`. Both render verbatim when no vault can answer |
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

## Resume trust (attestation)

Resuming a session used to re-scan the entire restored history through the
detection engine on the first request — the redaction cache is keyed by
message object reference and starts cold. Since the write path already
scrubs every persisted message, that rescan re-proved a property the
pipeline guarantees. Attestation removes that cost, deliberately minimal:

- A `message_end` scan that completes with **zero engine failures** marks
  the message clean. At each turn end one `pii-redaction/attest` custom
  entry persists the ids of the turn's clean-scrubbed messages (custom
  entries never enter LLM context).
- On startup, resume, or fork, attested ids seed the request-walk cache.
  Seeded history is never rescanned — content-independent, so token-heavy
  sessions benefit as much as clean ones.
- Everything else falls back to the full rescan: legacy files with no
  attest entries, fail-open scans (engine error or settle timeout returns
  the original text), messages written while redaction was off, broken
  object identity. There is **no healing**: the request hook records no
  evidence, so anything the write path did not scrub at write time is
  rescanned on every resume — today's behavior.
- **Accepted risk — attest and forget:** attestations carry no detection
  fingerprint. A policy, pattern, or build change does NOT re-redact
  attested lines. The live pipeline applied the then-current policy when
  the line ran, so anything a future policy would newly redact was already
  sent to the provider at that time; re-scanning on resume cannot undo
  the first exposure.
- Trust boundary: the local session file, the same boundary as the vault
  seed above. A forged attest entry in a hand-edited or foreign file can
  only skip scrubbing of that file's own content.

### Perf-gate fixtures

The resume instruction-count gate needs its fixture to carry attestation
written by the same kind of build that the gate runs. Produce it through
the real write path: run a session with redaction enabled to the target
size, quit, and snapshot the file — the turn-end attest entries are part
of it. Until that happens, an unattested fixture measures the fallback
path, by design.

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
