# ACP per-message model attribution

Every agent response chunk stream carries, in-band, the identity of the model
that produced that response — so a client can label any message with its model
without bookkeeping, and the attribution survives reload.

## The contract

The **first chunk emitted for each `messageId`** carries a `_meta` payload on
`session/update`:

```json
{
  "sessionUpdate": "agent_message_chunk",
  "messageId": "km.0",
  "content": { "type": "text", "text": "..." },
  "_meta": {
    "kimchi.dev": {
      "modelId": "kimchi-dev/glm-5.3",
      "requestedModelId": "kimchi-dev/auto"
    }
  }
}
```

Both `agent_message_chunk` and `agent_thought_chunk` carry it. Later chunks of
the same `messageId` omit `_meta` — **unless the value changed**, in which case
the next chunk re-carries a corrected `_meta`. A client applies the rule
**last-wins per `messageId`**: the latest `_meta` seen on any chunk of a
message is that message's attribution; chunks without `_meta` inherit the last
seen for that id. Since ACP transports are ordered and lossless, every **model
response** that streams at least one chunk announces its attribution.
Harness-synthesized chunks are not model responses and carry no `_meta` — for
example the image-refusal warning the agent emits when the selected model has
no vision input.

`_meta` is the ACP extensibility field; the nested `kimchi.dev` key is
kimchi's extension namespace (the same one ext methods and notifications
live under). Clients that don't read it ignore it per the protocol rules —
the field is always present in behavior, never advertised in capabilities.

## Field semantics

Both fields are `provider/modelId` refs — the same format as
`SessionModelState.currentModelId` and `availableModels`, so a client can join
`modelId` against the advertised model list to resolve a human-readable name
and capabilities.

- **`modelId`** — the model that **served** the response. When the backend
  reports a concrete served model (a routed virtual selection, or a redirected
  pin), this is that model's ref; otherwise it equals `requestedModelId`.
- **`requestedModelId`** — the model the request was **addressed** to: the
  virtual id when routed (e.g. `kimchi-dev/auto`), the concrete id when pinned.

The two are identical for every non-routed response — both fields are always
present, so clients need not branch on field presence.

Timing: the served model is usually known before the first token streams, but
a provider may report it late. The first chunk may therefore carry
`modelId === requestedModelId` as the best-known value, corrected by a later
chunk's `_meta` once the served model is known. The last-wins rule absorbs
this. When the served model is reported only at the response's end and all
text was already streamed, the correction arrives as a **zero-length chunk
matching the block's kind** — `agent_message_chunk` for text blocks,
`agent_thought_chunk` for thinking blocks — no content to append, the
corrected `_meta` under the same `messageId`. When ACP v2 whole-message
upserts land, the correction migrates onto them and the zero-length chunk
disappears.

Refs are composed directly from the provider's report; if the backend routes
to a model outside kimchi's catalog, the ref still carries the raw id — it
simply won't join against `availableModels`.

## Replay

`session/load` replays the transcript as chunks with the same stable
`messageId`s a live turn would have emitted, and every replayed chunk that
starts a message carries the same `_meta` — composed from the persisted
message tuple, not from current session state. Attribution therefore
survives reload with no client-side reconstruction. (See [Auto models](./model-routing.md)
for how routing itself persists: `message.model` keeps the requested virtual
id, `responseModel` stores the concrete pick.)

## Scope

- Every main-session assistant response, any provider — pinned, routed, or a
  backend-redirected pin.
- Under multi-model, main-session messages come from the orchestrator, so
  attribution names the orchestrator model; worker responses surface only as
  tool results and are out of scope.
- Subagent sessions are separate ACP sessions and carry their own attribution.

## Relationship to `_kimchi.dev/routed_model`

`routed_model` is the **change-event** channel: one notification per routing
change, silent when a later turn lands on the same model — suited to
status indicators that show the current pick. The `_meta` payload here is the
**per-message** channel: suited to labeling each response. Neither deprecates
the other. Both channels use the same id format: full `provider/modelId`
refs, joinable against the session's model list.
