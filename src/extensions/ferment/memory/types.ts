import { z } from "zod"

export const memoryFrontmatterSchema = z.object({
	schema_version: z.literal(1),
	scope: z.enum(["user", "project", "local"]),
	agent: z.string().optional(),
	ferment_id: z.string().optional(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
	tags: z.array(z.string()).default([]),
})
export type MemoryFrontmatter = z.infer<typeof memoryFrontmatterSchema>

export interface MemoryEntry {
	key: string
	scope: "user" | "project" | "local"
	body: string
	metadata: MemoryFrontmatter
}

export interface MemoryStore {
	read(scope: "user" | "project" | "local", key: string): Promise<MemoryEntry | null>
	write(entry: MemoryEntry): Promise<void>
	list(scope: "user" | "project" | "local", opts?: { agent?: string; ferment_id?: string }): Promise<MemoryEntry[]>
	delete(scope: "user" | "project" | "local", key: string): Promise<void>
}
