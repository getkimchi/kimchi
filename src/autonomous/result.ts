import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

const resultManifestSchema = z.object({
	exit_reason: z.enum(["done", "timeout", "error"]),
	started_at: z.string(),
	ended_at: z.string(),
	last_message: z.string().optional(),
	log_path: z.string().optional(),
	diff_path: z.string().optional(),
	error: z
		.object({
			message: z.string(),
			stack: z.string().optional(),
		})
		.optional(),
})

export type ResultManifest = z.infer<typeof resultManifestSchema>

function formatPath(path: ReadonlyArray<PropertyKey>): string {
	return path.reduce<string>((acc, segment, i) => {
		if (typeof segment === "number") {
			return `${acc}[${segment}]`
		}
		const seg = String(segment)
		return i === 0 ? seg : `${acc}.${seg}`
	}, "")
}

export function writeResult(dir: string, manifest: ResultManifest): void {
	const validation = resultManifestSchema.safeParse(manifest)
	if (!validation.success) {
		const paths = validation.error.issues.map((issue) => formatPath(issue.path)).join(", ")
		throw new Error(`Invalid result manifest: invalid field(s): ${paths}`)
	}

	mkdirSync(dir, { recursive: true })

	const tmpPath = join(dir, "result.json.tmp")
	const finalPath = join(dir, "result.json")

	writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf-8")
	renameSync(tmpPath, finalPath)
}

export function readResult(dir: string): ResultManifest {
	const filePath = join(dir, "result.json")

	let raw: string
	try {
		raw = readFileSync(filePath, "utf-8")
	} catch (err) {
		throw new Error(`Failed to read result manifest at ${filePath}: ${(err as Error).message}`)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new Error(`Failed to parse JSON in result manifest at ${filePath}: ${(err as Error).message}`)
	}

	const result = resultManifestSchema.safeParse(parsed)
	if (!result.success) {
		const paths = result.error.issues.map((issue) => formatPath(issue.path)).join(", ")
		throw new Error(`Invalid result manifest at ${filePath}: invalid field(s): ${paths}`)
	}

	return result.data
}
