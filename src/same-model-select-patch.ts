/**
 * Patches the upstream pi SDK so re-selecting the active model in the TUI model
 * menu still emits `model_select`. Pi 0.84.1 drops equal-model events, while
 * every direct `setModel()` call uses the same `"set"` source.
 *
 * Upstream: https://github.com/earendil-works/pi — no tracking issue filed
 * yet. Remove this module and its import in cli.ts once pi emits a
 * user-selection event for the already-active model itself.
 *
 * This module is imported for side effects. It must be loaded **before** any
 * model selection occurs so the prototype patch takes effect.
 */

import { type Api, type Model, modelsAreEqual } from "@earendil-works/pi-ai"
import { AgentSession, type ExtensionEvent, ModelSelectorComponent } from "@earendil-works/pi-coding-agent"

type ModelSelectEvent = Extract<ExtensionEvent, { type: "model_select" }>
type SetModel = (this: AgentSession, model: Model<Api>) => Promise<void>
type HandleSelect = (this: ModelSelectorComponent, model: Model<Api>) => void

// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype method patched for Pi 0.84.1
const agentSessionPrototype = AgentSession.prototype as any
// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype method patched for Pi 0.84.1
const modelSelectorPrototype = ModelSelectorComponent.prototype as any
const originalSetModel = agentSessionPrototype.setModel as SetModel
const originalHandleSelect = modelSelectorPrototype.handleSelect as HandleSelect
const modelMenuSelections = new WeakSet<Model<Api>>()

async function patchedSetModel(this: AgentSession, model: Model<Api>): Promise<void> {
	const previousModel = this.model
	const selectedFromMenu = modelMenuSelections.delete(model)
	await originalSetModel.call(this, model)
	if (!selectedFromMenu || !modelsAreEqual(previousModel, model)) return

	const extensionRunner = (this as unknown as { _extensionRunner: { emit(event: ModelSelectEvent): Promise<void> } })
		._extensionRunner
	await extensionRunner.emit({ type: "model_select", model, previousModel, source: "set" })
}

function patchedHandleSelect(this: ModelSelectorComponent, model: Model<Api>): void {
	modelMenuSelections.add(model)
	originalHandleSelect.call(this, model)
}

/** Remove when upstream emits a user-selection event for the active model. */
export function applySameModelSelectPatch(): void {
	if (typeof agentSessionPrototype.setModel !== "function" || typeof modelSelectorPrototype.handleSelect !== "function")
		return
	agentSessionPrototype.setModel = patchedSetModel
	modelSelectorPrototype.handleSelect = patchedHandleSelect
}

applySameModelSelectPatch()
