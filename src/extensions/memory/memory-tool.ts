import { Type } from "typebox"
import type { MemoryStore } from "./memory-store.js"
import type { MemoryAction, MemoryTarget } from "./types.js"

export const MEMORY_SCHEMA = Type.Object({
	action: Type.String({
		description: "The action to perform.",
		enum: ["add", "replace", "remove", "read"],
	}),
	target: Type.String({
		description: "Which memory store: 'memory' for personal notes, 'user' for user profile.",
		enum: ["memory", "user"],
	}),
	content: Type.Optional(Type.String({ description: "The entry content. Required for 'add' and 'replace'." })),
	old_text: Type.Optional(
		Type.String({ description: "Short unique substring identifying the entry to replace or remove." }),
	),
})

export interface MemoryToolArgs {
	action: MemoryAction
	target: MemoryTarget
	content?: string
	old_text?: string
}

export function createMemoryTool(store: MemoryStore) {
	return {
		name: "memory",
		label: "Memory",
		description:
			"Save durable information to persistent memory that survives across sessions. " +
			"Memory is injected into future turns, so keep it compact and focused on facts that will still matter later.\n\n" +
			"WHEN TO SAVE (do this proactively, don't wait to be asked):\n" +
			"- User corrects you or says 'remember this' / 'don't do that again'\n" +
			"- User shares a preference, habit, or personal detail (name, role, timezone, coding style)\n" +
			"- You discover something about the environment (OS, installed tools, project structure)\n" +
			"- You learn a convention, API quirk, or workflow specific to this user's setup\n" +
			"- You identify a stable fact that will be useful again in future sessions\n\n" +
			"PRIORITY: User preferences and corrections > environment facts > procedural knowledge. " +
			"The most valuable memory prevents the user from having to repeat themselves.\n\n" +
			"Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state to memory.\n" +
			"If you've discovered a new way to do something, solved a problem that could be necessary later, save it as a skill.\n\n" +
			"TWO TARGETS:\n" +
			"- 'user': who the user is — name, role, preferences, communication style, pet peeves\n" +
			"- 'memory': your notes — environment facts, project conventions, tool quirks, lessons learned\n\n" +
			"ACTIONS: add, replace (old_text identifies it), remove (old_text identifies it), read.\n\n" +
			"SKIP: trivial/obvious info, things easily re-discovered, raw data dumps, and temporary task state.",
		parameters: MEMORY_SCHEMA,
		async execute(_toolCallId: string, params: MemoryToolArgs) {
			const { action, target, content, old_text } = params
			switch (action) {
				case "add":
					return store.add(target, content ?? "")
				case "replace":
					return store.replace(target, old_text ?? "", content ?? "")
				case "remove":
					return store.remove(target, old_text ?? "")
				case "read":
					return store.read(target)
				default:
					return { success: false, error: `Unknown action '${action}'.` }
			}
		},
	}
}
