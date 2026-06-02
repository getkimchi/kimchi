/**
 * Separate from Pi's ModelRegistry which handles provider config, API keys,
 * and Model objects for inference. This registry holds orchestration metadata
 * (capabilities, strengths) so the Orchestrator LLM can make routing decisions.
 *
 * The registry is built from two sources:
 *   1. availableModels — the live metadata list fetched from the API at
 *      startup. This is the source of truth for which models actually exist
 *      and can be called.
 *   2. MODEL_CAPABILITIES — a local knowledge-base of curated orchestration
 *      metadata (tier, strengths, vision, description) keyed by model slug.
 *
 * Merging rules:
 *   - A model in the API with a capability entry → full descriptor.
 *   - A model in the API without a capability entry → generic descriptor +
 *     startup notice.
 *   - A model marked "ignored" in MODEL_CAPABILITIES → excluded silently
 *     (does not route, does not warn).
 *   - A model in the capability map but absent from the API → silently
 *     excluded from routing (it cannot be called).
 */

import type { ModelMetadata } from "../../../models.js"
import { MODEL_CAPABILITIES } from "./builtin-models.js"
import type { ModelCapabilities, OrchestrationModelDescriptor } from "./types.js"

export const KIMCHI_DEV_PROVIDER = "kimchi-dev"

const GENERIC_CAPABILITIES: ModelCapabilities = {
	vision: false,
	strengths: ["build"],
	tier: "standard",
	description: "No capability information available for this model.",
}

function modelIdToName(id: string): string {
	return id
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ")
}

function deriveName(m: ModelMetadata): string {
	return m.display_name.trim().length > 0 ? m.display_name : modelIdToName(m.slug)
}

export interface ModelRegistryWarning {
	kind: "unknown_model" | "deprecated_model"
	modelId: string
	replacement?: string // only for deprecated_model
}

export class ModelRegistry {
	private readonly allModels: OrchestrationModelDescriptor[]
	private readonly modelsWithCapabilities: OrchestrationModelDescriptor[]
	private readonly modelById: ReadonlyMap<string, OrchestrationModelDescriptor>
	readonly warnings: readonly ModelRegistryWarning[]

	constructor(availableModels: readonly ModelMetadata[]) {
		const warnings: ModelRegistryWarning[] = []
		const allModels: OrchestrationModelDescriptor[] = []

		for (const m of availableModels) {
			// Sunset models are excluded entirely, like "ignored"
			if (m.status === "sunset") continue

			// Deprecated warning is emitted even for ignored models so the
			// user gets notified even if the model isn't routed to subagents.
			if (m.status === "deprecated") {
				warnings.push({ kind: "deprecated_model", modelId: m.slug, replacement: m.replacement })
			}

			const entry = MODEL_CAPABILITIES.get(m.slug)
			if (entry === "ignored") continue

			if (entry === undefined) {
				if (m.status !== "deprecated") {
					warnings.push({ kind: "unknown_model", modelId: m.slug })
				}
				allModels.push({
					id: m.slug,
					provider: KIMCHI_DEV_PROVIDER,
					name: deriveName(m),
					capabilities: GENERIC_CAPABILITIES,
				})
			} else {
				allModels.push({
					id: m.slug,
					provider: KIMCHI_DEV_PROVIDER,
					name: deriveName(m),
					capabilities: entry,
				})
			}
		}

		this.allModels = allModels
		this.modelsWithCapabilities = this.allModels.filter((descriptor) => {
			const entry = MODEL_CAPABILITIES.get(descriptor.id)
			return entry !== undefined && entry !== "ignored"
		})
		this.modelById = new Map(this.modelsWithCapabilities.map((m) => [m.id, m]))
		this.warnings = warnings
	}

	getAll(): readonly OrchestrationModelDescriptor[] {
		return this.allModels
	}

	getModelsWithCapabilities(): readonly OrchestrationModelDescriptor[] {
		return this.modelsWithCapabilities
	}

	/** O(1) lookup by model ID. Only returns models with capability entries. */
	getModelById(id: string): OrchestrationModelDescriptor | undefined {
		return this.modelById.get(id)
	}
}
