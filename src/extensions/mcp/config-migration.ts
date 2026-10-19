/**
 * One-shot migration of pi-mcp-adapter-format MCP configs to pi 1.3's native
 * built-in MCP format. Runs once per install (stamp file) BEFORE the native MCP
 * extension reads its configs, translating:
 *
 * - the global harness config `<agentDir>/mcp.json` in place;
 * - the current project's `.kimchi/mcp.json` file(s) walking up from cwd (the
 *   patched native discovery reads exactly these);
 * - the kimchi `mcp.configs` setting's external files, inlined into the global
 *   file (the setting is removed afterwards by the caller).
 *
 * Untranslatable adapter-only fields and tiers are dropped and recorded in a
 * migration report (`<agentDir>/mcp-native-migration-report.json`); the user is
 * shown the report once. Original files are backed up next to themselves.
 *
 * Deliberate non-goals (user decisions, 2026-10-16):
 * - no OAuth token migration (adapter credential stores stay untouched; the
 *   re-login notice extension handles announcements);
 * - no live `imports:` semantics (agent-discovery one-shot import flows stay);
 * - no preservation of adapter-only fields (dropped-with-report policy).
 */
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import stripJsonComments from "strip-json-comments"

export interface MigrationIssue {
	/** "global" or the absolute path of the project file. */
	scope: string
	server?: string
	field?: string
	message: string
}

export interface MigrationReport {
	version: 1
	migratedAt: string
	files: Array<{ path: string; backup: string; changedServers: string[] }>
	issues: MigrationIssue[]
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Adapter-only server fields with no native equivalent (dropped + reported). */
/** Adapter-only server fields with no native equivalent (dropped + reported). */
export const UNSUPPORTED_SERVER_FIELDS = [
	"socket",
	"caFile",
	"requestHeadersCommand",
	"oauthCredentialStore",
	"oauthDir",
	"inheritEnv",
	"lifecycle",
	"idleTimeout",
	"protocolVersion",
	"tasks",
	"approveTools",
	"toolPrefix",
	"searchKeywords",
	"exposeResources",
	"pluginDataDir",
	"literalEnv",
	"httpTransport",
	"trace",
	"debug",
	"gateway",
] as const

function translateServer(name: string, entry: Json, scope: string, issues: MigrationIssue[]): Json {
	const drop = (field: string, extra = "") => {
		if (entry[field] === undefined) return
		issues.push({
			scope,
			server: name,
			field,
			message: `adapter-only field "${field}" dropped${extra ? `: ${extra}` : ""}`,
		})
		delete entry[field]
	}
	for (const field of UNSUPPORTED_SERVER_FIELDS) drop(field)

	// Legacy SSE transport is gone in the native runtime (streamable HTTP
	// only); point the entry at the same URL and report the downgrade.
	if (entry.type === "sse") {
		entry.type = undefined
		issues.push({
			scope,
			server: name,
			field: "type",
			message: `legacy SSE transport is not supported by the native MCP engine; server was downgraded to streamable HTTP against the same URL`,
		})
	}

	// enabled: adapter uses `disabled: true`; native uses `enabled: false`.
	if (entry.disabled === true) {
		entry.disabled = undefined
		if (entry.enabled === undefined) entry.enabled = false
	} else if (entry.disabled !== undefined) {
		entry.disabled = undefined
	}

	// requestTimeoutMs (ms) → timeout (seconds).
	if (typeof entry.requestTimeoutMs === "number") {
		const ms = entry.requestTimeoutMs
		entry.requestTimeoutMs = undefined
		if (entry.timeout === undefined) entry.timeout = Math.max(1, Math.round(ms / 1000))
		else drop("requestTimeoutMs", "native timeout already set")
	}

	// directTools → exposure. Include/exclude tool lists → toolExposure.
	if (entry.directTools === true) {
		entry.directTools = undefined
		if (entry.exposure === undefined) entry.exposure = "direct"
	} else if (entry.directTools !== undefined) {
		const value = entry.directTools
		entry.directTools = undefined
		issues.push({
			scope,
			server: name,
			field: "directTools",
			message: `directTools=${JSON.stringify(value)} approximated; native supports only per-server/per-tool exposure`,
		})
	}
	const toolExposure: Record<string, string> = {}
	const include = entry.includeTools
	if (Array.isArray(include)) {
		entry.includeTools = undefined
		for (const tool of include) if (typeof tool === "string") toolExposure[tool] = "direct"
		toolExposure["*"] = "hidden"
	} else if (include !== undefined) {
		entry.includeTools = undefined
		drop("includeTools", "unexpected shape")
	}
	const exclude = entry.excludeTools
	if (Array.isArray(exclude)) {
		entry.excludeTools = undefined
		for (const tool of exclude) if (typeof tool === "string") toolExposure[tool] = "hidden"
	} else if (exclude !== undefined) {
		entry.excludeTools = undefined
		drop("excludeTools", "unexpected shape")
	}
	if (Object.keys(toolExposure).length > 0)
		entry.toolExposure = { ...toolExposure, ...(isRecord(entry.toolExposure) ? entry.toolExposure : {}) }

	// Auth: native auto-OAuth on 401; `auth: "oauth"` and `oauth: {...}` clientId-ish
	// pieces carry over, the rest is dropped with a report entry. There is no way
	// to force-disable OAuth in native — auth:false/oauth:false only suspends it
	// until the server 401s, which is the same observable behavior for servers
	// that never ask.
	if (entry.auth === "oauth") {
		entry.auth = undefined
		issues.push({ scope, server: name, field: "auth", message: '"oauth" removed; native auto-starts OAuth on 401' })
	} else if (entry.auth === "bearer" || entry.auth === false) {
		const shorthand = JSON.stringify(entry.auth)
		entry.auth = undefined
		issues.push({
			scope,
			server: name,
			field: "auth",
			message: `${shorthand} removed; native has no force-off OAuth switch (OAuth only starts on a 401)`,
		})
	}
	// Observed adapter shorthands (`oauth: true | "http-only" | "oauth-mixed" | "user-managed"`)
	// have no native knob; native OAuth runs DCR automatically. `auth: { provider }` is
	// native as-is (global scope only; project files get a report entry instead).
	if (entry.oauth === true || typeof entry.oauth === "string") {
		const shorthand = JSON.stringify(entry.oauth)
		entry.oauth = undefined
		issues.push({
			scope,
			server: name,
			field: "oauth",
			message: `oauth shorthand ${shorthand} removed; native handles OAuth automatically`,
		})
	}
	if (isRecord(entry.oauth)) {
		const oauth = entry.oauth
		const keep: Json = {}
		for (const key of [
			"clientId",
			"clientSecret",
			"callbackPort",
			"callbackUrl",
			"scope",
			"clientName",
			"clientRegistration",
		] as const) {
			if (oauth[key] !== undefined) keep[key] = oauth[key]
		}
		for (const key of Object.keys(oauth)) {
			if (!(key in keep)) {
				issues.push({
					scope,
					server: name,
					field: `oauth.${key}`,
					message: `unsupported native OAuth key "${key}" dropped`,
				})
			}
		}
		if (Object.keys(keep).length > 0) entry.oauth = keep
		else entry.oauth = undefined
	}
	// adapter bearerToken fields → static Authorization header where recoverable.
	if (typeof entry.bearerTokenEnv === "string") {
		const envName = entry.bearerTokenEnv
		entry.bearerTokenEnv = undefined
		const headers = isRecord(entry.headers) ? { ...entry.headers } : {}
		if (headers.Authorization === undefined) headers.Authorization = `Bearer \${${envName}}`
		entry.headers = headers
	} else if (typeof entry.bearerToken === "string") {
		const token = entry.bearerToken
		entry.bearerToken = undefined
		const headers = isRecord(entry.headers) ? { ...entry.headers } : {}
		if (headers.Authorization === undefined) headers.Authorization = `Bearer ${token}`
		entry.headers = headers
		issues.push({
			scope,
			server: name,
			field: "bearerToken",
			message: "token inlined into headers.Authorization — ensure this file's permissions stay 0600",
		})
	}
	if (entry.bearerTokenStore !== undefined) {
		entry.bearerTokenStore = undefined
		issues.push({
			scope,
			server: name,
			field: "bearerTokenStore",
			message:
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} literal is user-facing guidance for native config files
				"adapter keychain token dropped; move the token into an env var and reference it as ${VAR} in headers.Authorization",
		})
	}
	if (scope !== "global" && isRecord(entry.auth) && typeof entry.auth.provider === "string") {
		entry.auth = undefined
		issues.push({
			scope,
			server: name,
			field: "auth",
			message: "{ provider } auth is global-only in native; moved server untouched otherwise",
		})
	}

	// Project full-copy disable overrides (adapter wrote copies with disabled:true
	// or override markers). Native: `{ "enabled": false }` if base exists in the
	// global chain. Detection is done by the caller via globalServerNames.
	return entry
}

function translateFile(
	path: string,
	scope: string,
	options: { globalServerNames: Set<string>; extraIssues?: MigrationIssue[] },
): { parsed: Json; issues: MigrationIssue[]; changedServers: string[]; changed: boolean } {
	const rawText = readFileSync(path, "utf8")
	const parsed: unknown = JSON.parse(stripJsonComments(rawText, { trailingCommas: true }))
	if (!isRecord(parsed)) throw new Error("expected a JSON object")
	const issues = options.extraIssues ?? []
	const changedServers: string[] = []
	// Whether the translation semantically changed this file: a dropped tier,
	// a renamed key, or at least one server entry whose serialized form differs
	// from the original. Already-native configs must not be rewritten (no
	// backup, no report entry) just to normalize formatting — changedServers
	// lists only semantically changed servers for the same reason.
	let changed = false

	for (const tier of ["imports", "claudePlugins"] as const) {
		if (parsed[tier] !== undefined) {
			issues.push({
				scope,
				field: tier,
				message: `"${tier}" tier dropped; native discovery does not read it. Pull configs from other agents with the kimchi agent-discovery import flows instead.`,
			})
			delete parsed[tier]
			changed = true
		}
	}
	if (parsed.settings !== undefined) {
		const keys = isRecord(parsed.settings) ? Object.keys(parsed.settings) : []
		issues.push({
			scope,
			field: "settings",
			message: `"settings" tier dropped (keys: ${keys.length > 0 ? keys.join(", ") : "none"}); native MCP has an equivalent for the autoEnableCodemode key only`,
		})
		if (
			isRecord(parsed.settings) &&
			typeof parsed.settings.autoEnableCodemode === "boolean" &&
			parsed.autoEnableCodemode === undefined
		) {
			parsed.autoEnableCodemode = parsed.settings.autoEnableCodemode
		}
		parsed.settings = undefined
		changed = true
	}

	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {}
	parsed.mcpServers = servers
	if (parsed["mcp-servers"] !== undefined) changed = true
	parsed["mcp-servers"] = undefined
	for (const [name, rawEntry] of Object.entries(servers)) {
		if (!isRecord(rawEntry)) continue
		// Adapter per-project full-copy disable overlays: project entry with its own
		// command/url, disabled:true, and a same-named server in the global chain.
		if (
			scope !== "global" &&
			rawEntry.disabled === true &&
			(rawEntry.command !== undefined || rawEntry.url !== undefined) &&
			options.globalServerNames.has(name)
		) {
			servers[name] = { enabled: false }
			changedServers.push(name)
			changed = true
			issues.push({
				scope,
				server: name,
				message: "adapter full-copy disable overlay reduced to the native { enabled: false } project override",
			})
			continue
		}
		const before = JSON.stringify(rawEntry)
		servers[name] = translateServer(name, rawEntry, scope, issues)
		if (JSON.stringify(servers[name]) !== before) {
			changedServers.push(name)
			changed = true
		}
	}
	return { parsed, issues, changedServers, changed }
}

function writeTranslated(path: string, parsed: Json): string {
	const backup = `${path}.pre-native-migration.bak`
	// Preserve the FIRST backup: a later migration run (project re-entry after
	// a lost record write, or a concurrent process) must never replace the
	// only copy of the original adapter config with already-migrated content.
	if (!existsSync(backup)) {
		copyFileSync(path, backup)
		chmodSync(backup, 0o600)
	}
	writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`)
	chmodSync(path, 0o600)
	return backup
}

/**
 * Write via temp-file + rename so a concurrent reader (the native engine
 * loading mcp.json, /status, the /mcp panel) never observes a torn file.
 */
function writeFileAtomic(path: string, contents: string): void {
	const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
	writeFileSync(tmp, contents, { mode: 0o600 })
	try {
		renameSync(tmp, path)
	} catch (error) {
		rmSync(tmp, { force: true })
		throw error
	}
}

/**
 * Claim a section with an O_EXCL lock file: two processes launching after an
 * upgrade must not both run. A crashed holder leaves the lock behind; after
 * `maxAgeMs` a later run takes it over, so a hard crash costs at most a delay,
 * never a stuck run. Shared by the config migration and the OAuth import.
 */
export function claimStaleLock(lockPath: string, maxAgeMs = 30_000): boolean {
	try {
		writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 })
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		try {
			if (Date.now() - statSync(lockPath).mtimeMs > maxAgeMs) {
				rmSync(lockPath, { force: true })
				writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 })
				return true
			}
		} catch {
			// Unreadable lock — treat it as held; staleness or a later run resolves it.
		}
		return false
	}
}

/**
 * Read one legacy layer file's servers into `bucket`. A layer below the native
 * target only fills gaps; one above it overrides (callers keep the buckets
 * separate). Parse failures become issues, never aborts.
 */
function readLegacyLayer(legacy: string, bucket: Record<string, Json>, issues: MigrationIssue[], verb: string): void {
	if (!existsSync(legacy)) return
	try {
		const parsed: unknown = JSON.parse(stripJsonComments(readFileSync(legacy, "utf8"), { trailingCommas: true }))
		const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {}
		for (const [name, entry] of Object.entries(servers)) {
			if (isRecord(entry)) bucket[name] = entry
		}
		if (Object.keys(servers).length > 0) {
			issues.push({
				scope: legacy,
				message: `legacy layer: servers ${verb} with precedence preserved; this file is no longer loaded by MCP`,
			})
		}
	} catch (error) {
		issues.push({
			scope: legacy,
			message: `legacy layer could not be read; its servers were NOT ${verb}: ${error instanceof Error ? error.message : String(error)}`,
		})
	}
}

/** Merge lower/upper legacy layers into a translated target: lower fills gaps, upper overrides. */
function foldLegacyLayers(
	servers: Json,
	changedServers: string[],
	lower: Record<string, Json>,
	upper: Record<string, Json>,
	scope: string,
	issues: MigrationIssue[],
): void {
	for (const [name, entry] of Object.entries(lower)) {
		if (servers[name] === undefined) {
			servers[name] = translateServer(name, { ...entry }, scope, issues)
			changedServers.push(name)
		}
	}
	for (const [name, entry] of Object.entries(upper)) {
		servers[name] = translateServer(name, { ...entry }, scope, issues)
		if (!changedServers.includes(name)) changedServers.push(name)
	}
}

export interface RunMigrationOptions {
	agentDir: string
	cwd: string
	/** User-global standard-MCP layer (legacy): defaults to ~/.config/mcp/mcp.json. */
	sharedGlobalPath?: string
	now?: Date
}

export interface RunMigrationResult {
	migrated: boolean
	report?: MigrationReport
}

export const MIGRATION_STAMP = "mcp-native-migration.done"
export const MIGRATION_REPORT = "mcp-native-migration-report.json"
const PROJECT_MIGRATION_RECORD = "mcp-native-migration-projects.json"
const MIGRATION_LOCK = "mcp-native-migration.lock"

/**
 * Idempotent: returns { migrated: false } when the stamp exists. Errors are
 * per-file best-effort and recorded as issues; the stamp is only written once
 * every attempted file either translated or errored. The migration is claimed
 * with an O_EXCL lock first, so two processes launching after an upgrade do
 * not both migrate (clobbering backups and reports over each other).
 */
export function runNativeMcpMigration(options: RunMigrationOptions): RunMigrationResult {
	const stampPath = join(options.agentDir, MIGRATION_STAMP)
	if (existsSync(stampPath)) return { migrated: false }
	// Fresh installs have no agent dir yet (this runs before pi creates it);
	// create it instead of failing the lock claim with ENOENT and deferring
	// the migration to a later launch.
	mkdirSync(options.agentDir, { recursive: true })
	const lockPath = join(options.agentDir, MIGRATION_LOCK)
	if (!claimStaleLock(lockPath)) return { migrated: false }

	const issues: MigrationIssue[] = []
	const files: MigrationReport["files"] = []
	const globalPath = join(options.agentDir, "mcp.json")

	const sharedGlobalPath = options.sharedGlobalPath ?? join(homedir(), ".config", "mcp", "mcp.json")
	const adapterGlobalPath = join(options.agentDir, "mcp-adapter.json")
	const hasLegacyGlobal = existsSync(sharedGlobalPath) || existsSync(adapterGlobalPath)

	let globalNames = new Set<string>()
	if (existsSync(globalPath) || hasLegacyGlobal) {
		// Inline legacy global layers, preserving adapter-era precedence:
		// shared-global (~/.config/mcp/mcp.json) was BELOW, mcp-adapter.json ABOVE
		// the harness mcp.json.
		const lowerGlobalServers: Record<string, Json> = {}
		const upperGlobalServers: Record<string, Json> = {}
		readLegacyLayer(sharedGlobalPath, lowerGlobalServers, issues, "inlined into the global mcp.json")
		readLegacyLayer(adapterGlobalPath, upperGlobalServers, issues, "inlined into the global mcp.json")
		try {
			if (!existsSync(globalPath)) writeFileAtomic(globalPath, `{ "mcpServers": {} }\n`)
			const translated = translateFile(globalPath, "global", { globalServerNames: new Set(), extraIssues: issues })
			const servers = translated.parsed.mcpServers as Json
			foldLegacyLayers(servers, translated.changedServers, lowerGlobalServers, upperGlobalServers, "global", issues)
			const legacyInlined = Object.keys(lowerGlobalServers).length + Object.keys(upperGlobalServers).length > 0
			if (translated.changed || legacyInlined) {
				const backup = writeTranslated(globalPath, translated.parsed)
				files.push({ path: globalPath, backup, changedServers: translated.changedServers })
			}
			globalNames = new Set(Object.keys(servers))
		} catch (error) {
			issues.push({
				scope: "global",
				message: `failed to translate ${globalPath}: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}

	// Project layers: walk cwd upward to HOME, translating every .kimchi/mcp.json.
	const seen = new Set<string>()
	for (let dir = options.cwd; !seen.has(dir); dir = dirname(dir)) {
		seen.add(dir)
		const candidate = join(dir, ".kimchi", "mcp.json")
		// Legacy project layers, lowest→highest precedence: .mcp.json, then
		// .kimchi/mcp.json (native target), then mcp-adapter.json.
		// Legacy project layers and their precedence relative to the native
		// target (.kimchi/mcp.json): .mcp.json is BELOW it, mcp-adapter.json ABOVE.
		const lowerLegacyServers: Record<string, Json> = {}
		const upperLegacyServers: Record<string, Json> = {}
		readLegacyLayer(join(dir, ".mcp.json"), lowerLegacyServers, issues, "folded into .kimchi/mcp.json")
		readLegacyLayer(
			join(dir, ".kimchi", "mcp-adapter.json"),
			upperLegacyServers,
			issues,
			"folded into .kimchi/mcp.json",
		)
		const hasLegacyServers = Object.keys(lowerLegacyServers).length + Object.keys(upperLegacyServers).length > 0
		if (existsSync(candidate) || hasLegacyServers) {
			try {
				if (!existsSync(candidate)) {
					writeFileAtomic(candidate, `{ "mcpServers": {} }\n`)
				}
				const translated = translateFile(candidate, candidate, { globalServerNames: globalNames, extraIssues: issues })
				const servers = translated.parsed.mcpServers as Json
				foldLegacyLayers(servers, translated.changedServers, lowerLegacyServers, upperLegacyServers, candidate, issues)
				const legacyFolded = Object.keys(lowerLegacyServers).length + Object.keys(upperLegacyServers).length > 0
				if (translated.changed || legacyFolded) {
					const backup = writeTranslated(candidate, translated.parsed)
					files.push({ path: candidate, backup, changedServers: translated.changedServers })
				}
			} catch (error) {
				issues.push({
					scope: candidate,
					message: `failed to translate: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
		}
		if (dirname(dir) === dir) break
	}

	const report: MigrationReport = {
		version: 1,
		migratedAt: (options.now ?? new Date()).toISOString(),
		files,
		issues,
	}
	// A clean, already-native migration writes no report: there is nothing to
	// review, and an empty report file (plus a rewritten config) would read as
	// a migration that dropped something.
	if (files.length > 0 || issues.length > 0) {
		writeFileAtomic(join(options.agentDir, MIGRATION_REPORT), `${JSON.stringify(report, null, 2)}\n`)
	}
	writeFileSync(stampPath, "1\n")
	rmSync(lockPath, { force: true })
	return { migrated: true, report }
}

function readProjectRecord(agentDir: string): string[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(agentDir, PROJECT_MIGRATION_RECORD), "utf8"))
		if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string")
	} catch {
		// Missing or unreadable — treat as empty.
	}
	return []
}

function appendReportIssues(agentDir: string, files: MigrationReport["files"], issues: MigrationIssue[]): void {
	const reportPath = join(agentDir, MIGRATION_REPORT)
	let existing: MigrationReport = { version: 1, migratedAt: new Date().toISOString(), files: [], issues: [] }
	try {
		const parsed: unknown = JSON.parse(readFileSync(reportPath, "utf8"))
		if (isRecord(parsed) && Array.isArray(parsed.files) && Array.isArray(parsed.issues))
			existing = {
				// Preserve fields this version does not know about (e.g.
				// `notifiedAt`, written by the migration notices): dropping them
				// would re-arm the one-shot "configs migrated" notice.
				...(parsed as unknown as MigrationReport),
				version: 1,
				migratedAt: typeof parsed.migratedAt === "string" ? parsed.migratedAt : new Date().toISOString(),
				files: parsed.files as MigrationReport["files"],
				issues: parsed.issues as MigrationIssue[],
			}
	} catch {
		// No report yet — start fresh.
	}
	existing.files.push(...files)
	existing.issues.push(...issues)
	writeFileAtomic(reportPath, `${JSON.stringify(existing, null, 2)}\n`)
}

/**
 * Translate one project's `.kimchi/mcp.json` (folding its legacy `.mcp.json` /
 * `.kimchi/mcp-adapter.json` layers) on demand. The one-shot launch migration
 * (runNativeMcpMigration) only walks the launching process's cwd ancestors —
 * ACP sessions run in other directories, so their project file would otherwise
 * stay adapter-format forever (native then silently ignores adapter-only
 * fields like `disabled: true`, re-enabling disabled servers). Idempotent per
 * project: translated cwds are recorded in `<agentDir>/mcp-native-migration-
 * projects.json`. No-op until the global one-shot has run (its stamp gates
 * this), so first-launch behavior is unchanged.
 */
export function runProjectMcpMigration(options: { agentDir: string; cwd: string; now?: Date }): { migrated: boolean } {
	if (!existsSync(join(options.agentDir, MIGRATION_STAMP))) return { migrated: false }
	const dir = resolve(options.cwd)
	const candidate = join(dir, ".kimchi", "mcp.json")
	const legacyPaths = [join(dir, ".mcp.json"), join(dir, ".kimchi", "mcp-adapter.json")]
	if (!existsSync(candidate) && !legacyPaths.some((path) => existsSync(path))) return { migrated: false }

	const record = readProjectRecord(options.agentDir)
	if (record.includes(dir)) return { migrated: false }

	const issues: MigrationIssue[] = []
	const files: MigrationReport["files"] = []
	// Disable-overlay detection needs the global chain's server names.
	const globalNames = new Set<string>()
	try {
		const globalPath = join(options.agentDir, "mcp.json")
		if (existsSync(globalPath)) {
			const parsed: unknown = JSON.parse(readFileSync(globalPath, "utf8"))
			const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {}
			for (const name of Object.keys(servers)) globalNames.add(name)
		}
	} catch {
		// Unreadable global config — proceed without overlay detection.
	}

	try {
		// Fold legacy project layers around the native target (same precedence
		// as the one-shot walk: .mcp.json below, mcp-adapter.json above).
		const lowerLegacyServers: Record<string, Json> = {}
		const upperLegacyServers: Record<string, Json> = {}
		readLegacyLayer(join(dir, ".mcp.json"), lowerLegacyServers, issues, "folded into .kimchi/mcp.json")
		readLegacyLayer(
			join(dir, ".kimchi", "mcp-adapter.json"),
			upperLegacyServers,
			issues,
			"folded into .kimchi/mcp.json",
		)
		if (!existsSync(candidate)) {
			writeFileAtomic(candidate, `{ "mcpServers": {} }\n`)
		}
		const translated = translateFile(candidate, candidate, { globalServerNames: globalNames, extraIssues: issues })
		const servers = translated.parsed.mcpServers as Json
		foldLegacyLayers(servers, translated.changedServers, lowerLegacyServers, upperLegacyServers, candidate, issues)
		const legacyFolded = Object.keys(lowerLegacyServers).length + Object.keys(upperLegacyServers).length > 0
		if (translated.changed || legacyFolded) {
			const backup = writeTranslated(candidate, translated.parsed)
			files.push({ path: candidate, backup, changedServers: translated.changedServers })
		}
	} catch (error) {
		issues.push({
			scope: candidate,
			message: `failed to translate: ${error instanceof Error ? error.message : String(error)}`,
		})
	}

	// Record the project either way — an already-native project file needs no
	// translation, and re-running the (cheap) no-op check every session buys
	// nothing — but only touch the report when something actually changed.
	if (files.length > 0 || issues.length > 0) {
		appendReportIssues(options.agentDir, files, issues)
	}
	writeFileAtomic(join(options.agentDir, PROJECT_MIGRATION_RECORD), `${JSON.stringify([...record, dir], null, 2)}\n`)
	return { migrated: true }
}
