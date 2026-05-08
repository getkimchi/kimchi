/**
 * Knowledge tools: add_decision and add_memory.
 *
 * Both append to the active ferment's persisted knowledge log. The system
 * prompt supplement injects these into the planner's context every turn — see
 * `before_agent_start` in index.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { VALID_MEMORY_CATEGORIES } from "../../../ferment/state-machine.js"
import type { MemoryCategory } from "../../../ferment/types.js"
import { applyAndPersist, failedToolResult, toolErr, toolOk } from "../tool-helpers.js"
import { DecisionParams, MemoryParams } from "../tool-schemas.js"

export function registerKnowledgeTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "add_decision",
		label: "Add Decision",
		description: "Record a decision.",
		parameters: DecisionParams,
		async execute(_, params) {
			const outcome = applyAndPersist(params.ferment_id, {
				type: "add_decision",
				title: params.title,
				description: params.description,
				phaseId: params.phase_id,
				stepId: params.step_id,
			})
			if (!outcome.ok) return failedToolResult(outcome.error)
			const last = outcome.ferment.decisions[outcome.ferment.decisions.length - 1]
			return toolOk(`Decision: ${last.id} — ${params.title}`)
		},
	})

	pi.registerTool({
		name: "add_memory",
		label: "Add Memory",
		description: "Record a memory.",
		parameters: MemoryParams,
		async execute(_, params) {
			// Pre-validate to keep the existing user-friendly error wording.
			if (!VALID_MEMORY_CATEGORIES.includes(params.category as MemoryCategory)) {
				return toolErr(`Invalid category "${params.category}". Use one of: ${VALID_MEMORY_CATEGORIES.join(", ")}.`)
			}
			const outcome = applyAndPersist(params.ferment_id, {
				type: "add_memory",
				category: params.category as MemoryCategory,
				content: params.content,
				phaseId: params.phase_id,
				stepId: params.step_id,
			})
			if (!outcome.ok) return failedToolResult(outcome.error)
			const last = outcome.ferment.memories[outcome.ferment.memories.length - 1]
			return toolOk(`Memory: ${last.id} [${params.category}]: ${params.content}`)
		},
	})
}
