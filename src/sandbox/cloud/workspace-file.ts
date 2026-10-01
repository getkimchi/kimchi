import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import {
	EGRESS_POLICY_FIELDS,
	type EgressPolicyConfig,
	WORKSPACE_RESOURCE_FIELDS,
	type WorkspaceResourcesConfig,
} from "./types.js"

/**
 * Project-root file carrying workspace provisioning settings (resource
 * requests, dependencies, egress policy; room for future sandbox-scoped
 * keys). Single-purpose and safe to commit — secrets never belong here.
 */
export const WORKSPACE_FILE_NAME = "kimchi_workspace.yaml"

export interface WorkspaceFileConfig {
	resources?: WorkspaceResourcesConfig
	/** CLI tools installed in the sandbox at boot: [registry:]tool[@version]. */
	dependencies?: string[]
	/** Outbound network policy of the workspace. `{}` parses to an empty mapping so the resolver can reject present-but-empty policies. */
	egressPolicy?: EgressPolicyConfig
}

/**
 * Thrown when `kimchi_workspace.yaml` exists but cannot be read or parsed.
 * Surfaced as a refusal: silently ignoring a broken file would fall back to
 * default sizing the user believes is overridden.
 */
export class WorkspaceFileError extends Error {
	constructor(
		message: string,
		public readonly filePath: string,
	) {
		super(message)
		this.name = "WorkspaceFileError"
	}
}

export interface LoadWorkspaceFileOptions {
	/** Override execFile (used by tests to stub the git boundary probe). */
	execFile?: typeof execFileSync
}

/**
 * Load workspace provisioning settings from the nearest
 * `kimchi_workspace.yaml`.
 *
 * Discovery walks up from `cwd` and returns the first hit, stopping after the
 * git repository root so a stray file above it (e.g. in the home directory)
 * never affects a project. Outside a git repo, only `cwd` itself is checked.
 *
 * Returns undefined when no file is found. Throws WorkspaceFileError when
 * the file exists but cannot be read or parsed.
 */
export function loadWorkspaceFile(cwd: string, options?: LoadWorkspaceFileOptions): WorkspaceFileConfig | undefined {
	const start = toRealPath(cwd)
	const boundaryRaw = gitRepoRoot(start, options)
	const boundary = boundaryRaw ? toRealPath(boundaryRaw) : undefined

	let dir = start
	for (;;) {
		const candidate = join(dir, WORKSPACE_FILE_NAME)
		if (existsSync(candidate)) return parseWorkspaceFile(candidate)
		if (boundary === undefined || dir === boundary) return undefined
		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}

function toRealPath(path: string): string {
	try {
		return realpathSync.native(path)
	} catch {
		return resolve(path)
	}
}

/** Git toplevel for `cwd`, or undefined when not inside a repo (or git is unavailable). */
function gitRepoRoot(cwd: string, options?: LoadWorkspaceFileOptions): string | undefined {
	const execImpl = options?.execFile ?? execFileSync
	try {
		const stdout = execImpl("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		})
		const trimmed = stdout.trim()
		return trimmed.length > 0 ? trimmed : undefined
	} catch {
		return undefined
	}
}

function parseWorkspaceFile(filePath: string): WorkspaceFileConfig {
	let raw: unknown
	try {
		raw = parseYaml(readFileSync(filePath, "utf-8"))
	} catch (err) {
		throw new WorkspaceFileError(
			`Could not parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			filePath,
		)
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new WorkspaceFileError(`Could not parse ${filePath}: expected a mapping at the top level`, filePath)
	}
	const mapping = raw as Record<string, unknown>
	const resources = parseResourcesSection(mapping.resources, filePath)
	const dependencies = parseDependenciesSection(mapping.dependencies, filePath)
	const egressPolicy = parseEgressPolicySection(mapping.egressPolicy, filePath)
	const out: WorkspaceFileConfig = {}
	if (resources) out.resources = resources
	if (dependencies) out.dependencies = dependencies
	if (egressPolicy) out.egressPolicy = egressPolicy
	return out
}

/**
 * Strict extraction: unknown keys, non-string values, and non-mapping
 * sections are WorkspaceFileErrors naming the offender — silently dropping
 * them would fall back to default sizing the user believes is overridden
 * (e.g. unquoted `cpu: 2` parses as a number in YAML).
 */
function parseResourcesSection(value: unknown, filePath: string): WorkspaceResourcesConfig | undefined {
	if (value === undefined) return undefined
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new WorkspaceFileError(
			`Could not parse ${filePath}: "resources" must be a mapping of ${WORKSPACE_RESOURCE_FIELDS.join(", ")} to quantity strings`,
			filePath,
		)
	}
	const raw = value as Record<string, unknown>
	for (const key of Object.keys(raw)) {
		if (!WORKSPACE_RESOURCE_FIELDS.some((field) => field === key)) {
			throw new WorkspaceFileError(
				`Unknown field "${key}" in resources in ${filePath} — valid fields: ${WORKSPACE_RESOURCE_FIELDS.join(", ")}`,
				filePath,
			)
		}
	}
	const out: WorkspaceResourcesConfig = {}
	for (const field of WORKSPACE_RESOURCE_FIELDS) {
		const fieldValue = raw[field]
		if (fieldValue === undefined) continue
		if (typeof fieldValue !== "string") {
			throw new WorkspaceFileError(
				`Invalid "${field}" value in ${filePath} — expected a quoted quantity string (e.g. ${field}: "500m"), got ${typeof fieldValue}. Quote the value.`,
				filePath,
			)
		}
		out[field] = fieldValue
	}
	return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Strict extraction, same contract as the resources parser: a non-array
 * section or non-string entry is a WorkspaceFileError. An empty array is
 * normalized to undefined (equivalent to absent); entry grammar is the
 * resolver's job.
 */
function parseDependenciesSection(value: unknown, filePath: string): string[] | undefined {
	if (value === undefined || value === null) return undefined
	if (!Array.isArray(value)) {
		throw new WorkspaceFileError(
			`Could not parse ${filePath}: "dependencies" must be an array of tool references (e.g. dependencies: ["jq", "node@22"])`,
			filePath,
		)
	}
	for (const entry of value) {
		if (typeof entry !== "string") {
			throw new WorkspaceFileError(
				`Invalid entry in dependencies in ${filePath} — expected a tool reference string (e.g. "node@22"), got ${typeof entry}. Quote the value.`,
				filePath,
			)
		}
	}
	return value.length > 0 ? value : undefined
}

/**
 * Strict extraction, same contract as the resources parser: unknown keys,
 * non-boolean denyByDefault, and non-string-array allowed/denied are
 * WorkspaceFileErrors naming the offender. A present-but-empty mapping is
 * returned as-is so the resolver can reject it (absent ≠ present-but-empty).
 */
function parseEgressPolicySection(value: unknown, filePath: string): EgressPolicyConfig | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new WorkspaceFileError(
			`Could not parse ${filePath}: "egressPolicy" must be a mapping (${EGRESS_POLICY_FIELDS.join(", ")})`,
			filePath,
		)
	}
	const raw = value as Record<string, unknown>
	for (const key of Object.keys(raw)) {
		if (!EGRESS_POLICY_FIELDS.some((field) => field === key)) {
			throw new WorkspaceFileError(
				`Unknown field "${key}" in egressPolicy in ${filePath} — valid fields: ${EGRESS_POLICY_FIELDS.join(", ")}`,
				filePath,
			)
		}
	}
	const out: EgressPolicyConfig = {}
	if (raw.denyByDefault !== undefined) {
		if (typeof raw.denyByDefault !== "boolean") {
			throw new WorkspaceFileError(
				`Invalid "denyByDefault" value in ${filePath} — expected a boolean (true/false), got ${typeof raw.denyByDefault}`,
				filePath,
			)
		}
		out.denyByDefault = raw.denyByDefault
	}
	for (const listField of ["allowed", "denied"] as const) {
		const list = raw[listField]
		if (list === undefined) continue
		if (!Array.isArray(list)) {
			throw new WorkspaceFileError(
				`Could not parse ${filePath}: "egressPolicy.${listField}" must be an array of destination strings (e.g. ["github.com:443", "*.cast.ai"])`,
				filePath,
			)
		}
		for (const entry of list) {
			if (typeof entry !== "string") {
				throw new WorkspaceFileError(
					`Invalid entry in egressPolicy.${listField} in ${filePath} — expected a destination string (e.g. "github.com:443"), got ${typeof entry}. Quote the value.`,
					filePath,
				)
			}
		}
		out[listField] = list
	}
	return out
}
