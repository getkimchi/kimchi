export type MemoryTarget = "memory" | "user"

export type MemoryAction = "add" | "replace" | "remove" | "read"

export interface MemoryStoreOptions {
	memoryDir: string
	memoryCharLimit: number
	userCharLimit: number
}

export interface MemoryToolResult {
	success: boolean
	target?: MemoryTarget
	entries?: string[]
	usage?: string
	entry_count?: number
	message?: string
	error?: string
	matches?: string[]
}
