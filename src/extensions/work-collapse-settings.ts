import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { isProjectScopeAllowed } from "../project-scope-trust.js"

/**
 * "Collapse work" setting — folds completed agent work (tool calls and,
 * in "all" mode, interstitial assistant commentary) into a single
 * "Worked for Xs" row.
 *
 * Modes:
 *  - "all":   fold tool calls AND interstitial assistant commentary (default)
 *  - "tools": fold tool calls only; assistant text and thinking stay visible
 *  - "off":   classic rendering, nothing folds
 *
 * Booleans are accepted for convenience: true → "all", false → "off".
 *
 * Scope: the global harness `<agentDir>/settings.json` is always read. The
 * project file `<cwd>/.kimchi/settings.json` overrides it ONLY when the caller
 * vouches for the project with `{ projectTrusted: true }` — a cloned repo must
 * not be able to force the most reductive display mode without a trust prompt.
 * Callers without session context should pass
 * `projectTrusted: resolveCollapseWorkProjectTrust(cwd)` (or omit it, which
 * reads global-only). `cwd` is authoritative; `process.cwd()` is never used.
 *
 * Writes are safe by construction:
 *  - the existing file is parsed (UTF-8 BOM stripped, like upstream
 *    `settings-manager`). If it exists but cannot be parsed, the write is
 *    REFUSED — a BOM, comment, or partial write must never let us replace the
 *    user's whole settings file with `{ collapseWork }`.
 *  - the parent directory is created recursively, the payload is written to a
 *    sibling temp file and then atomically renamed over the target, with mode
 *    0o600, and every failure is returned as a result instead of thrown.
 *  - the scope follows the effective value: when the project file already
 *    defines `collapseWork` and the project is trusted, the write goes there
 *    (so the `/settings` control is not a no-op under a project override);
 *    otherwise it goes global.
 *
 * A missing/invalid `collapseWork` key defaults to "all".
 */

export type CollapseWorkMode = "all" | "tools" | "off"

/** Settings file a write landed in, or would land in. */
export type CollapseWorkWriteScope = "global" | "project"

/** Non-throwing outcome of {@link writeCollapseWorkMode}. */
export type WriteCollapseWorkResult =
	| { ok: true; path: string; scope: CollapseWorkWriteScope }
	| { ok: false; error: string }

export interface CollapseWorkReadOptions {
	/** Read the project `.kimchi/settings.json` only when this is `true` (default: false). */
	projectTrusted?: boolean
	/** Test hook: clock used for the TTL cache. Defaults to `Date.now()`. */
	now?: number
}

export interface CollapseWorkWriteOptions {
	/** Session cwd. Required for a project-scope write; never read from `process.cwd()`. */
	cwd?: string
	/** Allow a project-scope write when the project file already overrides the mode. */
	projectTrusted?: boolean
}

export interface CollapseWorkProjectOptions {
	projectTrusted?: boolean
}

const SETTINGS_KEY = "collapseWork"
const SETTINGS_CACHE_TTL_MS = 5_000

export function getAgentDir(): string {
	return process.env.KIMCHI_CODING_AGENT_DIR ?? join(homedir(), ".config", "kimchi", "harness")
}

export function parseCollapseWorkMode(value: unknown): CollapseWorkMode | undefined {
	if (value === true) return "all"
	if (value === false) return "off"
	if (typeof value !== "string") return undefined
	const normalized = value.trim().toLowerCase()
	if (normalized === "all" || normalized === "everything") return "all"
	if (normalized === "tools" || normalized === "semi" || normalized === "tools-only") return "tools"
	if (normalized === "off" || normalized === "false" || normalized === "none") return "off"
	return undefined
}

/**
 * Project-trust lookup for callers that hold a session cwd but no
 * ExtensionContext (render paths, the `/settings` row). Delegates to the
 * process-wide project-scope gate and fails closed, exactly like every other
 * project-scoped kimchi reader. Extensions with context should prefer
 * `ctx.isProjectTrusted()`.
 */
export function resolveCollapseWorkProjectTrust(cwd: string): boolean {
	try {
		return isProjectScopeAllowed(cwd)
	} catch {
		return false
	}
}

function globalSettingsPath(): string {
	return join(getAgentDir(), "settings.json")
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, ".kimchi", "settings.json")
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

type LoadSettingsResult =
	| { ok: true; settings: Record<string, unknown>; existed: boolean }
	| { ok: false; error: string }

/**
 * Read + parse a settings file. A missing file is an empty settings object; an
 * unreadable or unparseable file is a failure the caller must not paper over
 * when writing. A UTF-8 BOM is stripped before parsing (upstream parity), so a
 * BOM alone never blocks a read or a write.
 */
function loadSettings(path: string): LoadSettingsResult {
	if (!existsSync(path)) return { ok: true, settings: {}, existed: false }
	let content: string
	try {
		content = readFileSync(path, "utf8")
	} catch (error) {
		return { ok: false, error: `cannot read ${path}: ${describeError(error)}` }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(content.replace(/^\uFEFF/, "")) as unknown
	} catch (error) {
		return { ok: false, error: `cannot parse ${path}: ${describeError(error)}` }
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: `cannot parse ${path}: expected a JSON object` }
	}
	return { ok: true, settings: parsed as Record<string, unknown>, existed: true }
}

function readModeFromFile(path: string): CollapseWorkMode | undefined {
	const loaded = loadSettings(path)
	if (!loaded.ok) return undefined
	return parseCollapseWorkMode(loaded.settings[SETTINGS_KEY])
}

/**
 * Whether `<cwd>/.kimchi/settings.json` defines `collapseWork` and the project
 * is trusted. The `/settings` layer uses this to label the row as overridden
 * and to decide whether cycling the value can land in that file.
 */
export function isCollapseWorkOverriddenByProject(cwd: string, opts: CollapseWorkProjectOptions = {}): boolean {
	if (opts.projectTrusted !== true) return false
	return readModeFromFile(projectSettingsPath(cwd)) !== undefined
}

interface CollapseWorkCache {
	value: CollapseWorkMode
	timestamp: number
	cwd: string
	projectTrusted: boolean
}

let cache: CollapseWorkCache | undefined

/**
 * Resolve the effective mode. The global harness settings are always read; the
 * project file only when the caller passes `projectTrusted: true`.
 */
export function readCollapseWorkMode(cwd: string, opts: CollapseWorkReadOptions = {}): CollapseWorkMode {
	const projectTrusted = opts.projectTrusted === true
	const now = opts.now ?? Date.now()
	if (
		cache &&
		cache.cwd === cwd &&
		cache.projectTrusted === projectTrusted &&
		now - cache.timestamp < SETTINGS_CACHE_TTL_MS
	) {
		return cache.value
	}
	const globalValue = readModeFromFile(globalSettingsPath())
	const projectValue = projectTrusted ? readModeFromFile(projectSettingsPath(cwd)) : undefined
	const value = projectValue ?? globalValue ?? "all"
	cache = { value, timestamp: now, cwd, projectTrusted }
	return value
}

/** Write `{"collapseWork": mode}` into an existing-or-new settings file, atomically and mode 0o600. */
function persistMode(path: string, mode: CollapseWorkMode, scope: CollapseWorkWriteScope): WriteCollapseWorkResult {
	const loaded = loadSettings(path)
	if (!loaded.ok) {
		// Never clobber content we cannot parse — that would erase the user's
		// theme, model, permissions, redaction, retry settings, ...
		return { ok: false, error: `refusing to overwrite unreadable settings: ${loaded.error}` }
	}
	const next = { ...loaded.settings, [SETTINGS_KEY]: mode }
	const dir = dirname(path)
	// Same-directory temp file so the rename is atomic on POSIX.
	const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
	try {
		mkdirSync(dir, { recursive: true })
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
		renameSync(tmp, path)
	} catch (error) {
		try {
			rmSync(tmp, { force: true })
		} catch {
			// Best-effort cleanup; the original failure is what matters.
		}
		return { ok: false, error: `cannot write ${path}: ${describeError(error)}` }
	} finally {
		resetCollapseWorkCache()
	}
	return { ok: true, path, scope }
}

/**
 * Persist the mode. Writes the project file when `projectTrusted === true`,
 * `cwd` is given, and that file already defines `collapseWork` (so a project
 * override is not silently shadowed); global otherwise. Never throws.
 */
export function writeCollapseWorkMode(
	mode: CollapseWorkMode,
	opts: CollapseWorkWriteOptions = {},
): WriteCollapseWorkResult {
	const { cwd, projectTrusted } = opts
	if (projectTrusted === true && cwd && isCollapseWorkOverriddenByProject(cwd, { projectTrusted })) {
		return persistMode(projectSettingsPath(cwd), mode, "project")
	}
	return persistMode(globalSettingsPath(), mode, "global")
}

export function resetCollapseWorkCache(): void {
	cache = undefined
}
