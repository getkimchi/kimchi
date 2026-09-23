# Backend-routed virtual models (`auto-beta`)

> Note: this page documents the harness support for **backend-routed** virtual
> models. The earlier, harness-side router (`kimchi-dev/auto`) is documented in
> [`docs/model-routing.md`](../model-routing.md). Both flows currently coexist.

The Kimchi backend provides virtual models that route requests itself: you ask
for the virtual id and the backend picks and serves the concrete model, then
reports the real pick in the OpenAI response `model` field. Today this model is
`auto-beta`; the plan is for the backend to eventually own the `auto` name.

The harness treats these models as ordinary `kimchi-dev` catalog entries — no
special authentication, endpoint, or custom provider. What it adds is awareness
of *which* concrete model served each request.

## What the harness does

For any `kimchi-dev` assistant message whose response `model` differs from the
requested id, pi-ai records the real pick on
`AssistantMessage.responseModel` (upstream, since pi-ai 0.71.0).

The `auto-model` extension (`src/extensions/auto-model/`) then:

1. **Learns the pick per response** — maps `responseModel` to the catalog model.
2. **Surfaces it** — appends a `<requested> picked <routed>.` notice entry to
   the transcript (e.g. `auto-beta picked kimi-k3.`), kept out of LLM context.
3. **Re-syncs capabilities** — copies the routed model's real context window,
   max tokens, reasoning, and thinking map onto the session descriptor, so
   compaction thresholds and thinking controls match what actually served.
4. **Tracks reroutes** — the backend may route each request to a different
   model (e.g. a vision model for an image prompt), so a new notice is emitted
   whenever the pick changes mid-session.
5. **Restores on resume** — hydration reads the last persisted pick so the
   notice and capabilities survive a session restart.

## Attribution

The persisted assistant message keeps `message.model` as the requested virtual
id (`auto-beta`) and stores the concrete pick in `responseModel`. This keeps
attribution honest (you asked for `auto-beta`, the backend routed it) and makes
resume work without extra bookkeeping. Surfaces that need the concrete model
(e.g. the prompt summary's model row) resolve it per-session.

## Coexistence

The v1 `auto` router (harness-side, documented in
[`docs/model-routing.md`](../model-routing.md)) and the backend-routed flow run
side by side. When the backend advertises `auto` directly, a collision guard in
the model catalog lets the backend's `auto` win over the synthesized v1 one,
so the two paths coexist without duplicating the `kimchi-dev/auto` entry.