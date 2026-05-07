import { readFileSync } from "node:fs"
import { z } from "zod"

const absolutePath = z.string().refine((p) => p.startsWith("/") && !p.split("/").some((seg) => seg === ".."), {
	message: "must be an absolute path with no '..' segments",
})

const mountSchema = z.object({
	host: absolutePath,
	container: absolutePath,
	readonly: z.boolean().optional(),
})

const taskSpecSchema = z.object({
	prompt: z.string().min(1),
	model: z.string().optional(),
	timeout_seconds: z.number().int().min(1).max(21600).default(3600),
	iterations: z.number().int().min(1).max(1000).optional(),
	env: z.record(z.string(), z.string()).optional(),
	mounts: z.array(mountSchema).optional(),
	success_criteria: z.string().optional(),
})

export type TaskSpec = z.infer<typeof taskSpecSchema>

function formatPath(path: ReadonlyArray<PropertyKey>): string {
	return path.reduce<string>((acc, segment, i) => {
		if (typeof segment === "number") {
			return `${acc}[${segment}]`
		}
		const seg = String(segment)
		return i === 0 ? seg : `${acc}.${seg}`
	}, "")
}

export function loadTaskSpec(filePath: string): TaskSpec {
	let raw: string
	try {
		raw = readFileSync(filePath, "utf-8")
	} catch (err) {
		throw new Error(`Failed to read task spec file at ${filePath}: ${(err as Error).message}`)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new Error(`Failed to parse JSON in task spec file at ${filePath}: ${(err as Error).message}`)
	}

	const result = taskSpecSchema.safeParse(parsed)
	if (!result.success) {
		const paths = result.error.issues.map((issue) => formatPath(issue.path)).join(", ")
		throw new Error(`Invalid task spec at ${filePath}: invalid field(s): ${paths}`)
	}

	return result.data
}
