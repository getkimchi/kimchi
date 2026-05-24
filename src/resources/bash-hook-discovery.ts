import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, extname, join, resolve } from "node:path"
import type { ResourceDefinition } from "./types.js"

export type BashHookScope = "global" | "project"

export interface BashHookResource extends ResourceDefinition {
	kind: "hooks"
	hookKind: "bash"
	scope: BashHookScope
	path: string
}

export function getGlobalBashHookDir(): string {
	return process.env.KIMCHI_CODING_AGENT_DIR
		? resolve(process.env.KIMCHI_CODING_AGENT_DIR, "hooks", "bash")
		: join(homedir(), ".config", "kimchi", "harness", "hooks", "bash")
}

export function getProjectBashHookDir(cwd = process.cwd()): string {
	return resolve(cwd, ".kimchi", "hooks", "bash")
}

export function discoverBashHookResources(cwd = process.cwd()): BashHookResource[] {
	const hooks = [
		...discoverBashHooksInDir(getGlobalBashHookDir(), "global"),
		...discoverBashHooksInDir(getProjectBashHookDir(cwd), "project"),
	]
	return hooks.sort((a, b) => a.id.localeCompare(b.id))
}

function discoverBashHooksInDir(dir: string, scope: BashHookScope): BashHookResource[] {
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter((name) => isBashHookFile(name, join(dir, name)))
		.map((name) => {
			const path = join(dir, name)
			const id = `hooks.bash.${scope}.${slug(name)}`
			return {
				id,
				kind: "hooks" as const,
				hookKind: "bash" as const,
				scope,
				path,
				label: `Bash: ${basename(name, extname(name))}`,
				description: `${scope} Bash hook at ${path}`,
				defaultEnabled: scope === "global",
			}
		})
}

function isBashHookFile(name: string, path: string): boolean {
	if (name.startsWith(".")) return false
	if (!name.endsWith(".sh") && !name.endsWith(".bash")) return false
	try {
		return statSync(path).isFile()
	} catch {
		return false
	}
}

function slug(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return normalized || "hook"
}
