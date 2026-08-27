import { type Api, type Model, modelsAreEqual } from "@earendil-works/pi-ai"
import { AgentSession, type ExtensionEvent } from "@earendil-works/pi-coding-agent"

type ModelSelectEvent = Extract<ExtensionEvent, { type: "model_select" }>
type EmitModelSelect = (
	this: AgentSession,
	nextModel: Model<Api>,
	previousModel: Model<Api> | undefined,
	source: ModelSelectEvent["source"],
) => Promise<void>

// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype method patched for Pi 0.84.1
const agentSessionPrototype = AgentSession.prototype as any
const originalEmitModelSelect = agentSessionPrototype._emitModelSelect as EmitModelSelect

async function patchedEmitModelSelect(
	this: AgentSession,
	nextModel: Model<Api>,
	previousModel: Model<Api> | undefined,
	source: ModelSelectEvent["source"],
): Promise<void> {
	if (source !== "set" || !modelsAreEqual(previousModel, nextModel)) {
		return originalEmitModelSelect.call(this, nextModel, previousModel, source)
	}

	// Pi 0.84.1's original method only guards equal models, then forwards this event.
	const extensionRunner = (this as unknown as { _extensionRunner: { emit(event: ModelSelectEvent): Promise<void> } })
		._extensionRunner
	await extensionRunner.emit({ type: "model_select", model: nextModel, previousModel, source })
}

/** Remove when upstream emits a user-selection event for the active model. */
export function applySameModelSelectPatch(): void {
	if (typeof agentSessionPrototype._emitModelSelect !== "function") return
	agentSessionPrototype._emitModelSelect = patchedEmitModelSelect
}

applySameModelSelectPatch()
