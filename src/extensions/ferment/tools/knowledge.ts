/**
 * Knowledge tools: add_decision and add_memory.
 *
 * Both append to the active ferment's persisted knowledge log. The system
 * prompt supplement injects these into the planner's context every turn — see
 * `before_agent_start` in index.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { MemoryCategory } from "../../../ferment/types.js"
import { getStorage, setActive } from "../state.js"
import { toolErr } from "../tool-helpers.js"
import { DecisionParams, MemoryParams } from "../tool-schemas.js"

const VALID_MEMORY_CATEGORIES: readonly MemoryCategory[] = [
	"architecture",
	"convention",
	"gotcha",
	"pattern",
	"preference",
]

export function registerKnowledgeTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "add_decision",
		label: "Add Decision",
		description: "Record a decision.",
		parameters: DecisionParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.addDecision(params.ferment_id, params.title, params.description, params.phase_id, params.step_id)
			if (!f) return toolErr("Ferment not found.")
			setActive(f)
			return {
				details: undefined,
				content: [{ type: "text", text: `Decision: ${f.decisions[f.decisions.length - 1].id} — ${params.title}` }],
			}
		},
	})

	pi.registerTool({
		name: "add_memory",
		label: "Add Memory",
		description: "Record a memory.",
		parameters: MemoryParams,
		async execute(_, params) {
			// Validate category — the type assertion would otherwise let any string through.
			if (!VALID_MEMORY_CATEGORIES.includes(params.category as MemoryCategory)) {
				return toolErr(`Invalid category "${params.category}". Use one of: ${VALID_MEMORY_CATEGORIES.join(", ")}.`)
			}
			const s = getStorage()
			const f = s.addMemory(
				params.ferment_id,
				params.category as MemoryCategory,
				params.content,
				params.phase_id,
				params.step_id,
			)
			if (!f) return toolErr("Ferment not found.")
			setActive(f)
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Memory: ${f.memories[f.memories.length - 1].id} [${params.category}]: ${params.content}`,
					},
				],
			}
		},
	})
}
