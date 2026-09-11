import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { WORKSPACE_RESOURCE_FIELDS, type WorkspaceResourcesConfig } from "./types.js"

/**
 * Project-root file carrying workspace provisioning settings (resource
 * requests today; room for future sandbox-scoped keys). Single-purpose and
 * safe to commit — secrets never belong here.
 */
export const WORKSPACE_FILE_NAME = "kimchi_workspace.yaml"

export interface WorkspaceFileConfig {
	resources?: WorkspaceResourcesConfig
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
	const resources = parseResourcesSection((raw as Record<string, unknown>).resources, filePath)
	return resources ? { resources } : {}
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
