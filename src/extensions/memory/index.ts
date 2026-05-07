import { join } from "node:path"
import { getAgentDir } from "@mariozechner/pi-coding-agent"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { MemoryStore } from "./memory-store.js"
import { createMemoryTool } from "./memory-tool.js"

export interface MemoryExtensionOptions {
	memoryDir?: string
	memoryCharLimit?: number
	userCharLimit?: number
}

export const DEFAULT_MEMORY_CHAR_LIMIT = 2200
export const DEFAULT_USER_CHAR_LIMIT = 1375

export default function memoryExtension(pi: ExtensionAPI, options?: MemoryExtensionOptions): void {
	const memoryDir = options?.memoryDir ?? join(getAgentDir(), "memory")
	const memoryCharLimit = options?.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT
	const userCharLimit = options?.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT

	const store = new MemoryStore({ memoryDir, memoryCharLimit, userCharLimit })

	pi.registerTool(createMemoryTool(store))

	// biome-ignore lint/suspicious/noExplicitAny: ctx shape not exported from pi-coding-agent
	pi.on("session_start", async (_event, ctx: any) => {
		await store.loadFromDisk()
		ctx.memorySnapshot = {
			memory: store.formatForSystemPrompt("memory") ?? null,
			user: store.formatForSystemPrompt("user") ?? null,
		}
	})

	pi.on("before_agent_start", async (event) => {
		const memory = store.formatForSystemPrompt("memory")
		const user = store.formatForSystemPrompt("user")
		if (!memory && !user) return
		const blocks = [memory, user].filter(Boolean).join("\n\n")
		return { systemPrompt: `${event.systemPrompt}\n\n${blocks}` }
	})
}
