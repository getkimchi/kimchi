# Auto models

Auto models are virtual models the Kimchi backend routes itself: you select
one, every request goes out under the virtual id, and the backend picks and
serves a concrete model, reporting the pick in the OpenAI response `model`
field. `auto` and `auto-beta` are current examples. The convention is general:
a model is routed virtual when it is a `kimchi-dev` catalog model whose id
starts with `auto` (`isAutoRoutedModel`); concrete models never use that
namespace.

Auto models are useful when you want Kimchi to choose between the models
available to you without switching models manually for every task.

## Selecting an auto model

Auto models appear in the model picker, on the command line (`--model auto`),
and in ACP model lists exactly when the backend catalog advertises them to
your account. There is no client-side gate or flag — what you can see is what
the backend serves. The harness treats them as ordinary `kimchi-dev` catalog
entries: no special authentication, endpoint, or custom provider.

## How routing works

Every request goes to the backend as the virtual id; the backend selects the
concrete model, serves the request, and reports the pick in the response
`model` field. pi-ai surfaces that on the assistant message as
`responseModel` (upstream, since pi-ai 0.71.0), and the auto-model extension
(`src/extensions/auto-model/`) uses it to:

1. **Learn the pick per response** — maps `responseModel` to the catalog
   model and announces it as `<virtual id> picked <model>.` in the transcript
   (kept out of LLM context).
2. **Re-sync capabilities** — copies the routed model's real context window,
   max tokens, reasoning, and thinking map onto the session descriptor, so
   compaction thresholds and thinking controls match what actually served.
3. **Track reroutes** — the backend may route each request to a different
   model (for example, a vision-capable model for an image prompt), so a new
   notice is emitted and capabilities re-synced whenever the pick changes.

The interface keeps showing the auto model as your selection before and after
routing. Once a pick is known, surfaces that have room for it render
`auto (<routed model>)` — the status line, prompt summary, and ACP model
lists included. Surfaces resolve the pick through the shared per-session
routing state (`state.ts`), keyed by the requested id.

## Failures

There is no client-side routing step to fail. If the backend cannot serve a
request, the provider error surfaces like any model error; submit again or
select a concrete model with `/model`.

## Session lifecycle

The routing decision belongs to the backend, per request:

- A new session on an auto model starts unresolved; the first response
  reveals the pick.
- Each request may land on a different concrete model.
- Resuming a session restores the auto model as the selection (and the last
  persisted pick notice); the backend routes each new request fresh.
- Switching away and back re-syncs against the next response.
- A concrete model provided on the command line when resuming overrides the
  auto model and is persisted as the new default (it is an explicit user
  choice).

Each local subagent that inherits an auto model requests the virtual id too;
the backend routes every session independently.

## Main-session behavior

For the main session (not subagents), the auto-model extension additionally:

- **Installs the default** — a fresh main session installs `auto` as the
  saved default once per install for entitled (cast.ai) accounts, and only
  when the backend catalog advertises it. The `autoDefaultApplied` marker in
  settings.json keeps a later switch-away permanent.
- **Persists explicit choices** — an explicit launch-time `--model` over an
  auto session is user-initiated and persists.
- **Unwraps saved defaults** — a persisted default is never wrapped in
  multi-model.

## Attribution

The persisted assistant message keeps `message.model` as the requested
virtual id and stores the concrete pick in `responseModel`. Requests are
always sent as the virtual id (never the concrete pick), while the transcript
records which concrete model served each response. This keeps attribution
honest and makes resume work without extra bookkeeping.
