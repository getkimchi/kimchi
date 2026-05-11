import { homedir } from "node:os"
import { join } from "node:path"
import { MarkdownFsMemoryStore } from "../extensions/ferment/memory/markdown-fs.js"

export async function runMemory(args: string[]): Promise<number> {
	const [subcommand, key, ...rest] = args

	const cwd = process.cwd()
	const userRoot = join(homedir(), ".kimchi", "memory", "user")
	const projectRoot = join(cwd, ".kimchi", "memory", "project")
	const localRoot = join(cwd, ".kimchi", "memory", "local")
	const store = new MarkdownFsMemoryStore({ userRoot, projectRoot, localRoot })

	if (subcommand === "get") {
		if (!key) {
			console.error("Usage: kimchi memory get <key> [--scope user|project|local]")
			return 1
		}
		const scope = (args.includes("--scope") ? args[args.indexOf("--scope") + 1] : "project") as
			| "user"
			| "project"
			| "local"
		const entry = await store.read(scope, key)
		if (!entry) {
			console.error(`Not found: ${key}`)
			return 1
		}
		console.log(entry.body)
		return 0
	}

	if (subcommand === "set") {
		if (!key) {
			console.error("Usage: kimchi memory set <key> <body> [--scope user|project|local]")
			return 1
		}
		// Extract --scope before computing body (must not leak into the value).
		const scopeIdx = args.indexOf("--scope")
		const scope = (scopeIdx >= 0 ? args[scopeIdx + 1] : "project") as "user" | "project" | "local"
		// Body is everything after key, minus --scope <value> if present.
		const scopeFlagCount = scopeIdx >= 0 ? 2 : 0
		// rest = args[2..]; strip the scope flag+value if it appears in the body region.
		const bodyEndIdx = scopeIdx >= 0 && scopeIdx >= 2 ? scopeIdx : args.length
		const body = args.slice(2, bodyEndIdx).join(" ")
		const now = new Date().toISOString()
		await store.write({
			key,
			scope,
			body,
			metadata: {
				schema_version: 1,
				scope,
				created_at: now,
				updated_at: now,
				tags: [],
			},
		})
		console.log(`Written: ${key}`)
		return 0
	}

	console.error("Usage: kimchi memory <get|set> <key> [args...]")
	return 1
}
