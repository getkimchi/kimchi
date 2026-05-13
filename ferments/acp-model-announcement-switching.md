# ACP Model Announcement And Switching

Use these answers with the ferment wizard.

## 1. What would you like to ferment?

```text
Add ACP model announcement and switching support
```

## 2. What does done look like? (goal)

```text
Done means Kimchi ACP sessions expose the harness' currently available models to ACP clients and allow the client to switch the active model during an existing session.

The implementation should use the ACP model protocol surface already present in the installed @agentclientprotocol/sdk version rather than inventing a Kimchi-only extension. Specifically, investigate and use the unstable model APIs/types if they are the right fit: SessionModelState, ModelInfo, models returned from session creation, and session/set_model via unstable_setSessionModel.

A new ACP session should return model state containing:
- currentModelId for the model actually active in the AgentSession
- availableModels for all models the session can switch to
- stable model IDs that the client can send back unchanged

When the ACP client requests a model switch, Kimchi should resolve the requested model ID against the session's available model registry, call the existing pi-coding-agent session model-switching API, emit/record the normal model selection behavior already used by the harness, and return a valid ACP response. The active session should continue after the switch; the change should affect subsequent turns without requiring a new ACP session.
```

## 3. How will we know we got there? (success criteria)

```text
We will know this is done when ACP clients can discover and switch models through the protocol.

Concrete success criteria:
- initialize/newSession behavior remains compatible with existing ACP clients.
- newSession returns ACP model state when a model is available, using the SDK's expected schema.
- availableModels are derived from the same source as the running AgentSession, not from a separate hard-coded list.
- currentModelId matches the active session model.
- unstable_setSessionModel is implemented on KimchiAcpAgent and validates sessionId and modelId.
- switching to a valid model calls AgentSession.setModel or the equivalent upstream API and updates the active model for future prompts.
- switching to an unknown or unavailable model returns a clear invalidParams-style ACP error.
- missing auth/no model behavior keeps the existing authRequired behavior.
- tests cover model state returned from newSession, successful model switching, unknown model failure, and preservation of existing prompt/tool streaming behavior.
- the implementation passes pnpm run test for the ACP server tests, and ideally pnpm run typecheck.
```

## 4. What should we avoid? Any non-negotiables?

```text
Do not modify patches/ directly. Do not reimplement pi-mono model selection logic if AgentSession and ModelRegistry already provide the needed APIs. Prefer an adapter inside src/modes/acp/server.ts plus small helpers/tests over a new cross-cutting subsystem.

Keep this scoped to ACP mode. Do not change interactive TUI model cycling, subagent model selection, ferment worker_model behavior, or the Kimchi model metadata fetch unless the ACP implementation needs a tiny shared formatter.

Use the installed @agentclientprotocol/sdk schema/types as the source of truth. Treat the model APIs as unstable and keep compatibility defensive: if a client ignores the model fields, normal prompting should still work.

Model IDs should be canonical and round-trippable. Prefer provider/modelId if needed to avoid collisions, but check the SDK schema and pi-coding-agent conventions before deciding. Do not expose display names as IDs.

Add colocated tests next to src/modes/acp/server.ts. Avoid broad refactors. Keep error handling consistent with the existing ACP server style, especially RequestError.invalidParams and authRequired.
```

## 5. Confirmation

```text
Yes, this looks right, provided the plan starts by mapping the existing ACP SDK model schema and pi-coding-agent model APIs, then implements model state advertisement in newSession, then implements unstable_setSessionModel, then adds focused ACP tests. Please keep it scoped to src/modes/acp/server.ts and colocated tests unless exploration proves a helper is warranted.
```
