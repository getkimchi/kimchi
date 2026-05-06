import { join } from "node:path"
import { getAgentDir } from "@mariozechner/pi-coding-agent"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { MemoryStore } from "./memory-store.js"
import { createMemoryTool } from "./memory-tool.js"
import type { MemoryContext } from "./types.js"

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

	const tool = createMemoryTool(store)
	pi.registerTool(tool)

	pi.on("session_start", async (_event, ctx) => {
		await store.loadFromDisk()
		;(ctx as MemoryContext).memorySnapshot = {
			memory: store.formatForSystemPrompt("memory"),
			user: store.formatForSystemPrompt("user"),
		}
	})
}
