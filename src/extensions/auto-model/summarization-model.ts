import type { Api, Model } from "@earendil-works/pi-ai"
import { AgentSession } from "@earendil-works/pi-coding-agent"
import { resolveEffectiveModel } from "./state.js"

type SummarizationAuthResolver = (this: AgentSession, model: Model<Api>) => Promise<unknown>

interface AgentSessionSummarizationPrototype {
	_getSummarizationRequestAuth: SummarizationAuthResolver
}

let installed = false

/**
 * Pi gives compaction and branch-summary calls isolated request session IDs.
 * Resolve their request model from the owning AgentSession before that ID is
 * replaced, so an Auto session summarizes with its saved concrete target.
 */
export function installAutoSummarizationModelAdapter(): void {
	if (installed) return
	installed = true

	const prototype = AgentSession.prototype as unknown as AgentSessionSummarizationPrototype
	const getSummarizationRequestAuth = prototype._getSummarizationRequestAuth
	prototype._getSummarizationRequestAuth = function (model) {
		const effectiveModel = resolveEffectiveModel(model, this.sessionManager.getSessionId())
		return getSummarizationRequestAuth.call(this, effectiveModel ?? model)
	}
}
