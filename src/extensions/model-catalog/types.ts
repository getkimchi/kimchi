/**
 * Relative cost/capability tier used by the Orchestrator to match task
 * difficulty to model weight class.
 *
 *  - "light"    — smallest active parameters, cheapest to run, best for
 *                  straightforward tasks where speed and cost matter most.
 *  - "standard" — balanced cost/capability, good default for most coding
 *                  tasks that don't require the heaviest reasoning.
 *  - "heavy"    — largest active parameters, most expensive, reserved for
 *                  complex multi-step tasks or when special capabilities
 *                  (e.g. vision, agent swarm) are needed.
 */
export type ModelTier = "light" | "standard" | "heavy"

export type Phase = "explore" | "research" | "plan" | "build" | "review"

/** Injected into the Orchestrator LLM's context to steer model selection. */
export interface ModelCapabilities {
	vision: boolean
	tier: ModelTier
	description: string
	/** Phase-specific guideline annexes. If a phase key is present, its value
	 *  REPLACES the default guideline for that phase. If absent, the default
	 *  guideline is used. */
	guidelines?: Partial<Readonly<Record<Phase, string>>>
	/** Orchestration-specific guideline annex. Appended to the system prompt
	 *  when this model acts as the orchestrator. If absent, the default
	 *  orchestration guideline is used. */
	orchestrationGuidelines?: string
}

/**
 * Not a replacement for Pi's Model type — this adds orchestration metadata
 * and references the Pi model via (id, provider) for sub-agent spawning.
 */
export interface OrchestrationModelDescriptor {
	id: string
	provider: string
	name: string
	capabilities: ModelCapabilities
}
