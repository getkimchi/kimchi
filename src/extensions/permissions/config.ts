import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { isProjectScopeAllowed } from "../../project-scope-trust.js"
import { DEFAULT_CONFIG, PERMISSION_MODES } from "./constants.js"
import type { PermissionsConfig } from "./types.js"

const modeSchema = z.enum(PERMISSION_MODES)

const configSchema = z
	.object({
		defaultMode: modeSchema.optional(),
		allow: z.array(z.string()).optional(),
		deny: z.array(z.string()).optional(),
		classifierTimeoutMs: z.number().int().positive().optional(),
		classifierMaxTotalMs: z.number().int().positive().optional(),
	})
	.strict()

export interface LoadedConfig {
	config: PermissionsConfig
	allowBySource: { user: string[]; project: string[]; local: string[]; cli: string[] }
	denyBySource: { user: string[]; project: string[]; local: string[]; cli: string[] }
	paths: { user?: string; project?: string; local?: string; cliOverride?: string }
}

export interface LoadConfigOptions {
	cwd: string
	cliConfigPath?: string
	cliAllow?: string[]
	cliDeny?: string[]
}

const USER_CONFIG_PATH = resolve(homedir(), ".config", "kimchi", "harness", "permissions.json")
const PROJECT_CONFIG_SUFFIX = join(".kimchi", "permissions.json")
const LOCAL_CONFIG_SUFFIX = join(".kimchi", "permissions.local.json")

function readConfigFile(path: string): {
	data: PermissionsConfig | null
	/** Preserve omission so a sparse higher-priority file does not erase an inherited budget. */
	classifierMaxTotalMs?: number
	error?: string
} {
	if (!existsSync(path)) return { data: null }
	try {
		const raw = readFileSync(path, "utf-8")
		const parsed = JSON.parse(raw)
		const validated = configSchema.safeParse(parsed)
		if (!validated.success) {
			return { data: null, error: `${path}: ${validated.error.message}` }
		}
		return {
			classifierMaxTotalMs: validated.data.classifierMaxTotalMs,
			data: {
				defaultMode: validated.data.defaultMode ?? DEFAULT_CONFIG.defaultMode,
				allow: validated.data.allow ?? [],
				deny: validated.data.deny ?? [],
				classifierTimeoutMs: validated.data.classifierTimeoutMs ?? DEFAULT_CONFIG.classifierTimeoutMs,
				classifierMaxTotalMs: validated.data.classifierMaxTotalMs ?? DEFAULT_CONFIG.classifierMaxTotalMs,
			},
		}
	} catch (err) {
		return { data: null, error: `${path}: ${(err as Error).message}` }
	}
}

export function loadConfig(options: LoadConfigOptions): { loaded: LoadedConfig; errors: string[] } {
	const errors: string[] = []

	const userRead = readConfigFile(USER_CONFIG_PATH)
	if (userRead.error) errors.push(userRead.error)

	// Project and local files are gated on project trust: an untrusted repo's
	// .kimchi/permissions.json must not relax the permission layer (allow
	// rules, defaultMode) until the folder is trusted.
	const projectScopeAllowed = isProjectScopeAllowed(options.cwd)
	const projectPath = resolve(options.cwd, PROJECT_CONFIG_SUFFIX)
	const projectRead = projectScopeAllowed ? readConfigFile(projectPath) : { data: null }
	if (projectRead.error) errors.push(projectRead.error)

	const localPath = resolve(options.cwd, LOCAL_CONFIG_SUFFIX)
	const localRead = projectScopeAllowed ? readConfigFile(localPath) : { data: null }
	if (localRead.error) errors.push(localRead.error)

	const cliPath = options.cliConfigPath
	const cliRead = cliPath ? readConfigFile(resolve(cliPath)) : { data: null }
	if (cliRead.error) errors.push(cliRead.error)

	let effective: PermissionsConfig
	if (cliRead.data) {
		effective = cliRead.data
	} else {
		const user = userRead.data ?? DEFAULT_CONFIG
		const project = projectRead.data
		const local = localRead.data
		effective = {
			defaultMode: local?.defaultMode ?? project?.defaultMode ?? user.defaultMode,
			allow: [...user.allow, ...(project?.allow ?? []), ...(local?.allow ?? [])],
			deny: [...user.deny, ...(project?.deny ?? []), ...(local?.deny ?? [])],
			classifierTimeoutMs: local?.classifierTimeoutMs ?? project?.classifierTimeoutMs ?? user.classifierTimeoutMs,
			classifierMaxTotalMs:
				localRead.classifierMaxTotalMs ?? projectRead.classifierMaxTotalMs ?? user.classifierMaxTotalMs,
		}
	}

	const loaded: LoadedConfig = {
		config: effective,
		allowBySource: {
			user: userRead.data?.allow ?? [],
			project: projectRead.data?.allow ?? [],
			local: localRead.data?.allow ?? [],
			cli: options.cliAllow ?? [],
		},
		denyBySource: {
			user: userRead.data?.deny ?? [],
			project: projectRead.data?.deny ?? [],
			local: localRead.data?.deny ?? [],
			cli: options.cliDeny ?? [],
		},
		paths: {
			user: userRead.data ? USER_CONFIG_PATH : undefined,
			project: projectRead.data ? projectPath : undefined,
			local: localRead.data ? localPath : undefined,
			cliOverride: cliRead.data && cliPath ? resolve(cliPath) : undefined,
		},
	}

	return { loaded, errors }
}

export function userConfigPath(): string {
	return USER_CONFIG_PATH
}

export function projectConfigPath(cwd: string): string {
	return resolve(cwd, PROJECT_CONFIG_SUFFIX)
}

export function appendToConfig(path: string, toAdd: { allow?: string[]; deny?: string[] }): string {
	let existing: PermissionsConfig = { ...DEFAULT_CONFIG }
	if (existsSync(path)) {
		const read = readConfigFile(path)
		if (read.data) existing = read.data
	} else {
		mkdirSync(dirname(path), { recursive: true })
	}
	const merged: PermissionsConfig = {
		...existing,
		allow: dedupe([...(existing.allow ?? []), ...(toAdd.allow ?? [])]),
		deny: dedupe([...(existing.deny ?? []), ...(toAdd.deny ?? [])]),
	}
	writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8")
	return path
}

function dedupe(items: string[]): string[] {
	return Array.from(new Set(items.map((s) => s.trim()).filter(Boolean)))
}
