import { createHash } from "node:crypto"
import { lstat, mkdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { applyOfflineGuarantees, offlineEnvironment, type ReviewNetworkBoundary } from "./network-boundary.js"
import type { ReviewWorktree } from "./types.js"

export const REVIEW_ENVIRONMENT_SCHEMA_VERSION = "review-environment/v1"
export const REVIEW_ENVIRONMENTS_STATE_VERSION = "review-environments/v1"
export const REVIEW_ENVIRONMENT_OUTPUT_LIMIT = 8 * 1024
export const REVIEW_ENVIRONMENT_PROMPT_LIMIT = 8 * 1024
export const REVIEW_ENVIRONMENT_SETUP_TIMEOUT_MS = 120_000
export const REVIEW_ENVIRONMENT_PROBE_TIMEOUT_MS = 30_000
export const REVIEW_ENVIRONMENT_TOTAL_TIMEOUT_MS = 300_000

const ID_PATTERN = /^[A-Za-z0-9_-]+$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SUBSTITUTION_PATTERN = /\$\{(cache:[A-Za-z0-9_-]+|private:[A-Za-z0-9_-]+|worktree|scratch)\}/g
const MAX_ENV_ENTRIES = 64
const MAX_ENV_VALUE_BYTES = 4096
const MAX_ENV_TOTAL_BYTES = 64 * 1024
const MAX_PRIVATE_DIRS = 32
const MAX_SETUP_COMMANDS = 8
const MAX_PROBES = 16

export interface ReviewEnvironmentGap {
	kind: string
	name: string
	note: string
}

export interface ReviewCacheCatalogEntry {
	id: string
	path: string
	description?: string
}

export interface ReviewToolchainCatalogEntry {
	id: string
	bin: string[]
}

export interface ReviewEnvironmentPrivateDir {
	id: string
	root: "cache" | "build" | "scratch"
	path: string
}

export interface ReviewEnvironmentCommand {
	argv: string[]
	cwd: string
	timeoutMs: number
}

export interface ReviewEnvironmentSetupCommand extends ReviewEnvironmentCommand {
	required: boolean
}

export interface ReviewEnvironmentProbe extends ReviewEnvironmentCommand {
	id: string
	required: boolean
}

export interface ReviewEnvironmentSpec {
	readOnlyCaches: string[]
	privateDirs: ReviewEnvironmentPrivateDir[]
	env: Record<string, string>
	toolchain?: string
	setup: ReviewEnvironmentSetupCommand[]
	probes: ReviewEnvironmentProbe[]
}

export interface ReviewEnvironmentSettings {
	caches: ReviewCacheCatalogEntry[]
	toolchains: ReviewToolchainCatalogEntry[]
	profiles: {
		default?: ReviewEnvironmentSpec
		repositories: Record<string, ReviewEnvironmentSpec>
	}
}

export interface ResolvedReviewEnvironmentSettings {
	settings: ReviewEnvironmentSettings
	gaps: ReviewEnvironmentGap[]
}

export interface ReviewEnvironmentPlan {
	profileApplied: boolean
	requestedSpec: ReviewEnvironmentSpec
	caches: ReviewCacheCatalogEntry[]
	toolchains: ReviewToolchainCatalogEntry[]
	gaps: ReviewEnvironmentGap[]
}

export interface ReviewEnvironmentBoundary {
	kind: ReviewNetworkBoundary["kind"] | "outer-sandbox" | "unavailable"
	capabilities: {
		networkOff: boolean
		filesystemConfinement: boolean
		readOnlyMounts: boolean
		/** False records use of portable marker/tree cleanup instead of a PID namespace. */
		preparationPidNamespace?: boolean
	}
}

export interface ReviewEnvironmentCommandRecord {
	argv: string[]
	cwd: string
	timeoutMs: number
	required: boolean
	status: "passed" | "failed" | "timeout" | "cancelled" | "blocked" | "skipped"
	exitCode?: number | null
	elapsedMs: number
	output: string
}

export interface ReviewEnvironmentProbeRecord extends ReviewEnvironmentCommandRecord {
	id: string
}

export interface ReviewEnvironmentReceipt {
	schemaVersion: typeof REVIEW_ENVIRONMENT_SCHEMA_VERSION
	profileApplied: boolean
	worktreeId: string
	worktreePath: string
	scratchPath: string
	homePath: string
	cachePath: string
	buildPath: string
	requestedSpec: ReviewEnvironmentSpec
	effectiveSpec: ReviewEnvironmentSpec
	requestedSpecDigest: string
	receiptDigest: string
	resolvedCaches: ReviewCacheCatalogEntry[]
	privateDirectories: Array<ReviewEnvironmentPrivateDir & { resolvedPath: string }>
	toolchain?: ReviewToolchainCatalogEntry
	environment: Record<string, string>
	setup: ReviewEnvironmentCommandRecord[]
	probes: ReviewEnvironmentProbeRecord[]
	boundary: ReviewEnvironmentBoundary
	readiness: "ready" | "degraded" | "unready"
	gaps: ReviewEnvironmentGap[]
	nonHermeticInputs: string[]
}

export interface ReviewEnvironmentExecutionResult {
	status: "passed" | "failed" | "cancelled" | "blocked"
	exitCode?: number | null
	elapsedMs: number
	output: string
	timedOut?: boolean
	gap?: ReviewEnvironmentGap
}

export interface PrepareReviewEnvironmentOptions {
	worktreeId: string
	worktree: Omit<ReviewWorktree, "env" | "environment" | "readOnlyCachePaths">
	/** Legacy isolated defaults owned by the worktree pool, not this generic engine. */
	privateEnv: Record<string, string>
	plan: ReviewEnvironmentPlan
	boundary: ReviewEnvironmentBoundary
	/** Canonical repository, context, output, run, and common-Git paths. */
	forbiddenCachePaths: string[]
	baseEnv?: NodeJS.ProcessEnv
	signal?: AbortSignal
	execute: (worktree: ReviewWorktree, command: ReviewEnvironmentCommand) => Promise<ReviewEnvironmentExecutionResult>
	/** Discard the failed worktree and create a fresh tracked-only fallback at a new path. */
	resetToIsolated: (worktree: ReviewWorktree) => Promise<{
		worktree: PrepareReviewEnvironmentOptions["worktree"]
		privateEnv: Record<string, string>
	}>
}

export function emptyReviewEnvironmentSpec(): ReviewEnvironmentSpec {
	return { readOnlyCaches: [], privateDirs: [], env: {}, setup: [], probes: [] }
}

export function emptyReviewEnvironmentSettings(): ReviewEnvironmentSettings {
	return { caches: [], toolchains: [], profiles: { repositories: {} } }
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.")
	return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`${label} contains unknown key ${JSON.stringify(key)}.`)
	}
}

function text(value: unknown, label: string, maximum = 4096, trim = true): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string.`)
	const result = trim ? value.trim() : value
	if (!result || result.includes("\0") || Buffer.byteLength(result, "utf8") > maximum) {
		throw new Error(`${label} must be non-empty, NUL-free, and at most ${maximum} bytes.`)
	}
	return result
}

function id(value: unknown, label: string): string {
	const result = text(value, label, 80)
	if (!ID_PATTERN.test(result)) throw new Error(`${label} may contain only letters, digits, underscores, and hyphens.`)
	return result
}

function absolutePath(value: unknown, label: string): string {
	const result = text(value, label, 4096)
	if (!isAbsolute(result)) throw new Error(`${label} must be absolute.`)
	return resolve(result)
}

function uniqueId(ids: Set<string>, value: string, label: string): void {
	if (ids.has(value)) throw new Error(`${label} ID ${JSON.stringify(value)} is duplicated.`)
	ids.add(value)
}

function stringArray(value: unknown, label: string, maximum: number): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) {
		throw new Error(`${label} must be an array with at most ${maximum} entries.`)
	}
	return value
}

function parseCaches(value: unknown): ReviewCacheCatalogEntry[] {
	if (value === undefined) return []
	const ids = new Set<string>()
	return stringArray(value, "review.environment.caches", 64).map((entry) => {
		const cache = object(entry)
		keys(cache, ["id", "path", "description"], "review.environment.caches entry")
		const cacheId = id(cache.id, "Cache ID")
		uniqueId(ids, cacheId, "Cache")
		return {
			id: cacheId,
			path: absolutePath(cache.path, `Cache ${cacheId} path`),
			...(cache.description === undefined
				? {}
				: { description: text(cache.description, `Cache ${cacheId} description`, 500) }),
		}
	})
}

function parseToolchains(value: unknown): ReviewToolchainCatalogEntry[] {
	if (value === undefined) return []
	const ids = new Set<string>()
	return stringArray(value, "review.environment.toolchains", 32).map((entry) => {
		const toolchain = object(entry)
		keys(toolchain, ["id", "bin"], "review.environment.toolchains entry")
		const toolchainId = id(toolchain.id, "Toolchain ID")
		uniqueId(ids, toolchainId, "Toolchain")
		const bin = stringArray(toolchain.bin, `Toolchain ${toolchainId} bin`, 32).map((path, index) =>
			absolutePath(path, `Toolchain ${toolchainId} bin[${index}]`),
		)
		if (bin.length === 0 || new Set(bin).size !== bin.length) {
			throw new Error(`Toolchain ${toolchainId} bin must contain distinct directories.`)
		}
		return { id: toolchainId, bin }
	})
}

function safeRelativePath(value: unknown, label: string): string {
	const result = text(value, label, 512)
	if (isAbsolute(result) || result.split(/[\\/]/).includes("..")) {
		throw new Error(`${label} must be a contained relative path.`)
	}
	return result
}

function parseCommand(value: unknown, label: string, maximumTimeoutMs: number): ReviewEnvironmentCommand {
	const command = object(value)
	keys(command, ["argv", "cwd", "timeoutMs", "required", "id"], label)
	const argv = stringArray(command.argv, `${label}.argv`, 32).map((argument, index) =>
		text(argument, `${label}.argv[${index}]`, 4096, false),
	)
	if (argv.length === 0 || Buffer.byteLength(argv.join("\0"), "utf8") > 16 * 1024) {
		throw new Error(`${label}.argv must be non-empty and at most 16 KiB.`)
	}
	if (
		!Number.isSafeInteger(command.timeoutMs) ||
		(command.timeoutMs as number) < 1 ||
		(command.timeoutMs as number) > maximumTimeoutMs
	) {
		throw new Error(`${label}.timeoutMs must be from 1 to ${maximumTimeoutMs}.`)
	}
	return {
		argv,
		cwd: command.cwd === undefined ? "." : safeRelativePath(command.cwd, `${label}.cwd`),
		timeoutMs: command.timeoutMs as number,
	}
}

function parseSpec(value: unknown, label: string): ReviewEnvironmentSpec {
	const spec = object(value)
	keys(spec, ["readOnlyCaches", "privateDirs", "env", "toolchain", "setup", "probes"], label)
	const cacheIds = new Set<string>()
	const readOnlyCaches = stringArray(spec.readOnlyCaches ?? [], `${label}.readOnlyCaches`, 64).map((entry) => {
		const cacheId = id(entry, `${label}.readOnlyCaches entry`)
		uniqueId(cacheIds, cacheId, `${label} cache`)
		return cacheId
	})
	const privateIds = new Set<string>()
	const privateDirs = stringArray(spec.privateDirs ?? [], `${label}.privateDirs`, MAX_PRIVATE_DIRS).map((entry) => {
		const directory = object(entry)
		keys(directory, ["id", "root", "path"], `${label}.privateDirs entry`)
		const directoryId = id(directory.id, `${label} private directory ID`)
		uniqueId(privateIds, directoryId, `${label} private directory`)
		let root: ReviewEnvironmentPrivateDir["root"]
		switch (directory.root) {
			case "cache":
				root = "cache"
				break
			case "build":
				root = "build"
				break
			case "scratch":
				root = "scratch"
				break
			default:
				throw new Error(`${label} private directory ${directoryId} root must be cache, build, or scratch.`)
		}
		return {
			id: directoryId,
			root,
			path: safeRelativePath(directory.path, `${label} private directory ${directoryId} path`),
		}
	})
	const envInput = object(spec.env ?? {})
	if (Object.keys(envInput).length > MAX_ENV_ENTRIES) throw new Error(`${label}.env has too many entries.`)
	const env: Record<string, string> = {}
	let totalBytes = 0
	for (const [name, raw] of Object.entries(envInput)) {
		if (!ENV_NAME_PATTERN.test(name) || name === "PATH") {
			throw new Error(`${label}.env contains an invalid name ${JSON.stringify(name)}; use toolchain for PATH.`)
		}
		if (typeof raw !== "string" || raw.includes("\0") || Buffer.byteLength(raw, "utf8") > MAX_ENV_VALUE_BYTES) {
			throw new Error(`${label}.env.${name} must be a NUL-free string of at most ${MAX_ENV_VALUE_BYTES} bytes.`)
		}
		const valueText = raw
		if (profileEnvironmentViolation(name, valueText)) {
			throw new Error(`${label}.env.${name} contains credential-like configuration and is not allowed.`)
		}
		const remainder = valueText.replace(SUBSTITUTION_PATTERN, "")
		if (remainder.includes("${")) {
			throw new Error(`${label}.env.${name} contains a forbidden or unterminated substitution.`)
		}
		totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(valueText, "utf8")
		env[name] = valueText
	}
	if (totalBytes > MAX_ENV_TOTAL_BYTES) throw new Error(`${label}.env exceeds ${MAX_ENV_TOTAL_BYTES} bytes.`)
	const setup = stringArray(spec.setup ?? [], `${label}.setup`, MAX_SETUP_COMMANDS).map((entry, index) => {
		const setupObject = object(entry)
		keys(setupObject, ["argv", "cwd", "timeoutMs", "required"], `${label}.setup[${index}]`)
		if (setupObject.required !== undefined && typeof setupObject.required !== "boolean") {
			throw new Error(`${label}.setup[${index}].required must be a boolean.`)
		}
		return {
			...parseCommand(entry, `${label}.setup[${index}]`, REVIEW_ENVIRONMENT_SETUP_TIMEOUT_MS),
			required: setupObject.required !== false,
		}
	})
	const probeIds = new Set<string>()
	const probes = stringArray(spec.probes ?? [], `${label}.probes`, MAX_PROBES).map((entry, index) => {
		const probeObject = object(entry)
		keys(probeObject, ["id", "argv", "cwd", "timeoutMs", "required"], `${label}.probes[${index}]`)
		const probeId = id(probeObject.id, `${label}.probes[${index}].id`)
		uniqueId(probeIds, probeId, `${label} probe`)
		if (probeObject.required !== undefined && typeof probeObject.required !== "boolean") {
			throw new Error(`${label}.probes[${index}].required must be a boolean.`)
		}
		return {
			id: probeId,
			...parseCommand(entry, `${label}.probes[${index}]`, REVIEW_ENVIRONMENT_PROBE_TIMEOUT_MS),
			required: probeObject.required !== false,
		}
	})
	return {
		readOnlyCaches,
		privateDirs,
		env,
		...(spec.toolchain === undefined ? {} : { toolchain: id(spec.toolchain, `${label}.toolchain`) }),
		setup,
		probes,
	}
}

/** Strictly parse only the environment subsection. Environment-specific errors
 * become typed gaps and an isolated configuration instead of aborting review. */
export function parseTrustedReviewEnvironment(value: unknown): ResolvedReviewEnvironmentSettings {
	if (value === undefined) return { settings: emptyReviewEnvironmentSettings(), gaps: [] }
	try {
		const environment = object(value)
		keys(environment, ["caches", "toolchains", "profiles"], "review.environment")
		const profilesValue = environment.profiles === undefined ? {} : object(environment.profiles)
		keys(profilesValue, ["default", "repositories"], "review.environment.profiles")
		const repositoriesValue = profilesValue.repositories === undefined ? {} : object(profilesValue.repositories)
		if (Object.keys(repositoriesValue).length > 64) throw new Error("At most 64 repository profiles are allowed.")
		const repositories: Record<string, ReviewEnvironmentSpec> = {}
		for (const [root, profile] of Object.entries(repositoriesValue)) {
			if (!isAbsolute(root) || root.includes("\0")) {
				throw new Error(`Repository profile key ${JSON.stringify(root)} must be an absolute canonical root.`)
			}
			repositories[resolve(root)] = parseSpec(profile, `Repository profile ${root}`)
		}
		return {
			settings: {
				caches: parseCaches(environment.caches),
				toolchains: parseToolchains(environment.toolchains),
				profiles: {
					...(profilesValue.default === undefined
						? {}
						: { default: parseSpec(profilesValue.default, "Default environment profile") }),
					repositories,
				},
			},
			gaps: [],
		}
	} catch (error) {
		return {
			settings: emptyReviewEnvironmentSettings(),
			gaps: [
				{
					kind: "invalid_environment_settings",
					name: "review.environment",
					note: `Trusted environment settings were rejected; using isolated review environments: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		}
	}
}

function contained(parent: string, candidate: string): boolean {
	const remainder = relative(parent, candidate)
	return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder))
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
	const metadata = await lstat(path)
	if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`)
	if (!metadata.isDirectory()) throw new Error(`${label} is not a directory.`)
	const canonical = await realpath(path)
	if (!(await stat(canonical)).isDirectory()) throw new Error(`${label} is not a directory.`)
	return canonical
}

/** Canonicalize catalog entries once per pool. Profile selection is exact and a
 * repository profile replaces (rather than merges with) the default profile. */
export async function resolveReviewEnvironmentPlan(
	settings: ReviewEnvironmentSettings,
	repository: string,
	initialGaps: readonly ReviewEnvironmentGap[] = [],
): Promise<ReviewEnvironmentPlan> {
	const gaps = [...initialGaps]
	const canonicalRepository = await realpath(repository)
	const caches: ReviewCacheCatalogEntry[] = []
	for (const cache of settings.caches) {
		try {
			caches.push({ ...cache, path: await canonicalDirectory(cache.path, `Cache ${cache.id}`) })
		} catch (error) {
			gaps.push({
				kind: "invalid_environment_cache",
				name: cache.id,
				note: `Read-only cache is unavailable and will not be exposed: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}
	const toolchains: ReviewToolchainCatalogEntry[] = []
	for (const toolchain of settings.toolchains) {
		try {
			toolchains.push({
				...toolchain,
				bin: await Promise.all(
					toolchain.bin.map((path) => canonicalDirectory(path, `Toolchain ${toolchain.id} directory`)),
				),
			})
		} catch (error) {
			gaps.push({
				kind: "invalid_environment_toolchain",
				name: toolchain.id,
				note: `Toolchain is unavailable and will not be selected: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}
	let profileApplied = settings.profiles.default !== undefined
	let requestedSpec = settings.profiles.default
	for (const [configuredRoot, profile] of Object.entries(settings.profiles.repositories)) {
		try {
			if ((await realpath(configuredRoot)) === canonicalRepository) {
				requestedSpec = profile
				profileApplied = true
			}
		} catch (error) {
			gaps.push({
				kind: "invalid_environment_profile",
				name: configuredRoot,
				note: `Repository profile root cannot be canonicalized and was ignored: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}
	return {
		profileApplied,
		requestedSpec: structuredClone(requestedSpec ?? emptyReviewEnvironmentSpec()),
		caches,
		toolchains,
		gaps,
	}
}

function credentialName(name: string): boolean {
	return /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_AUTH(?:_|$)|^AUTH(?:_|$)|_OPTS$|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SESSION|COOKIE|(?:^|_)PAT$|(?:^|_)DSN$)/i.test(
		name,
	)
}

function valueHasCredentials(value: string): boolean {
	if (/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/.test(value)) return true
	try {
		if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
			const parsed = new URL(value)
			if (parsed.username || parsed.password) return true
		}
	} catch {
		// The generic URL-with-userinfo check below still applies.
	}
	return /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#@]+:[^\s/?#@]+@/.test(value)
}

function profileEnvironmentViolation(name: string, value: string): string | undefined {
	if (credentialName(name)) return "credential-like name"
	if (valueHasCredentials(value)) return "credential-bearing value"
	return undefined
}

function validateExpandedEnvironment(environment: Record<string, string>): void {
	let totalBytes = 0
	for (const [name, value] of Object.entries(environment)) {
		if (Buffer.byteLength(value, "utf8") > MAX_ENV_VALUE_BYTES) {
			throw new Error(`Expanded environment ${name} exceeds ${MAX_ENV_VALUE_BYTES} bytes.`)
		}
		if (profileEnvironmentViolation(name, value)) {
			throw new Error(`Expanded environment ${name} contains credential-like configuration and is not allowed.`)
		}
		totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8")
	}
	if (totalBytes > MAX_ENV_TOTAL_BYTES) {
		throw new Error(`Expanded environment exceeds the aggregate ${MAX_ENV_TOTAL_BYTES}-byte limit.`)
	}
}

function networkConfigurationName(name: string): boolean {
	return /(?:PROXY|REGISTRY|_INDEX(?:_|$)|^UV_INDEX$)/i.test(name)
}

/** Compose in the required order without allowing spec values to replace the
 * safe PATH or survive in credential-bearing network variables. */
export function assembleReviewEnvironment(options: {
	baseEnv: NodeJS.ProcessEnv
	worktreeEnv: Record<string, string>
	specEnv: Record<string, string>
	toolchain?: ReviewToolchainCatalogEntry
}): Record<string, string> {
	const safe = offlineEnvironment({ ...options.baseEnv, ...options.worktreeEnv })
	const merged: NodeJS.ProcessEnv = { ...safe }
	for (const [name, value] of Object.entries(options.specEnv)) {
		if (profileEnvironmentViolation(name, value)) {
			throw new Error(`Environment variable ${name} is not allowed because it contains credential-like configuration.`)
		}
		if (networkConfigurationName(name)) continue
		merged[name] = value
	}
	if (options.toolchain) {
		merged.PATH = [...options.toolchain.bin, ...(safe.PATH ? [safe.PATH] : [])].join(
			process.platform === "win32" ? ";" : ":",
		)
	}
	return applyOfflineGuarantees(merged) as Record<string, string>
}

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function requestedReviewEnvironmentDigest(options: {
	spec: ReviewEnvironmentSpec
	caches: ReviewCacheCatalogEntry[]
	toolchain?: ReviewToolchainCatalogEntry
}): string {
	return sha256({
		schemaVersion: REVIEW_ENVIRONMENT_SCHEMA_VERSION,
		spec: options.spec,
		caches: options.caches.map(({ id, path }) => ({ id, path })),
		...(options.toolchain ? { toolchain: options.toolchain } : {}),
	})
}

function stableEnvironmentValue(value: string, receipt: ReviewEnvironmentReceipt): string {
	let result = value
	const replacements: Array<[string, string]> = [
		[receipt.worktreePath, `\${worktree}`],
		[receipt.scratchPath, `\${scratch}`],
		[receipt.homePath, "<home>"],
		[receipt.cachePath, "<cache-root>"],
		[receipt.buildPath, "<build-root>"],
		...receipt.privateDirectories.map(
			(directory) => [directory.resolvedPath, `\${private:${directory.id}}`] as [string, string],
		),
	]
	for (const [actual, logical] of replacements.sort((left, right) => right[0].length - left[0].length)) {
		if (actual) result = result.split(actual).join(logical)
	}
	return result
}

export function reviewEnvironmentReceiptDigest(receipt: ReviewEnvironmentReceipt): string {
	return sha256({
		schemaVersion: receipt.schemaVersion,
		worktreeId: receipt.worktreeId,
		requestedSpecDigest: receipt.requestedSpecDigest,
		effectiveSpec: receipt.effectiveSpec,
		resolvedCaches: receipt.resolvedCaches.map(({ id, path }) => ({ id, path })),
		privateDirectories: receipt.privateDirectories.map(({ id, root, path }) => ({ id, root, path })),
		...(receipt.toolchain ? { toolchain: receipt.toolchain } : {}),
		environment: Object.fromEntries(
			Object.entries(receipt.environment)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([name, value]) => [name, stableEnvironmentValue(value, receipt)]),
		),
		setup: receipt.setup.map(({ argv, cwd, required, status, exitCode }) => ({
			argv,
			cwd,
			required,
			status,
			exitCode,
		})),
		probes: receipt.probes.map(({ id, argv, cwd, required, status, exitCode }) => ({
			id,
			argv,
			cwd,
			required,
			status,
			exitCode,
		})),
		boundary: receipt.boundary,
		readiness: receipt.readiness,
		gaps: receipt.gaps,
		nonHermeticInputs: receipt.nonHermeticInputs,
	})
}

function expandedEnvironment(
	spec: ReviewEnvironmentSpec,
	caches: Map<string, ReviewCacheCatalogEntry>,
	privateDirectories: Map<string, string>,
	worktree: PrepareReviewEnvironmentOptions["worktree"],
): Record<string, string> {
	const result: Record<string, string> = {}
	for (const [name, template] of Object.entries(spec.env)) {
		result[name] = template.replace(SUBSTITUTION_PATTERN, (_match, replacement: string) => {
			if (replacement === "worktree") return worktree.path
			if (replacement === "scratch") return worktree.scratchDir
			if (replacement.startsWith("cache:")) {
				const value = caches.get(replacement.slice("cache:".length))?.path
				if (!value) throw new Error(`Environment ${name} references unavailable substitution \${${replacement}}.`)
				return value
			}
			const value = privateDirectories.get(replacement.slice("private:".length))
			if (!value) throw new Error(`Environment ${name} references unavailable substitution \${${replacement}}.`)
			return value
		})
	}
	validateExpandedEnvironment(result)
	return result
}

async function createPrivateDirectory(root: string, directory: ReviewEnvironmentPrivateDir): Promise<string> {
	const canonicalRoot = await realpath(root)
	let current = canonicalRoot
	for (const part of directory.path.split(/[\\/]/).filter((part) => part && part !== ".")) {
		current = join(current, part)
		try {
			const metadata = await lstat(current)
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
				throw new Error(`Private directory ${directory.id} traverses a non-directory or symbolic link.`)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			await mkdir(current, { mode: 0o700 })
		}
	}
	const canonical = await realpath(current)
	if (!contained(canonicalRoot, canonical) || canonical === canonicalRoot) {
		throw new Error(`Private directory ${directory.id} must be a child of its worktree-owned root.`)
	}
	return canonical
}

function commandRecord(
	command: ReviewEnvironmentSetupCommand | ReviewEnvironmentProbe,
	result: ReviewEnvironmentExecutionResult,
): ReviewEnvironmentCommandRecord {
	return {
		argv: [...command.argv],
		cwd: command.cwd,
		timeoutMs: command.timeoutMs,
		required: command.required,
		status: result.timedOut ? "timeout" : result.status,
		...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
		elapsedMs: result.elapsedMs,
		output: result.output.slice(-REVIEW_ENVIRONMENT_OUTPUT_LIMIT),
	}
}

function skippedRecord(
	command: ReviewEnvironmentSetupCommand | ReviewEnvironmentProbe,
): ReviewEnvironmentCommandRecord {
	return {
		argv: [...command.argv],
		cwd: command.cwd,
		timeoutMs: command.timeoutMs,
		required: command.required,
		status: "skipped",
		elapsedMs: 0,
		output: "Not run because environment preparation was unavailable or an earlier step failed.",
	}
}

function failureGap(
	kind: "setup_failed" | "probe_failed" | "environment_aborted",
	name: string,
	note: string,
): ReviewEnvironmentGap {
	return { kind, name, note: note.slice(0, 1000) }
}

/** Prepare one concrete worktree. The returned worktree always receives a
 * complete env and boundary-capability receipt; callers persist it before
 * marking a manifest entry ready. */
export async function prepareReviewEnvironment(
	options: PrepareReviewEnvironmentOptions,
): Promise<{ worktree: ReviewWorktree; receipt: ReviewEnvironmentReceipt }> {
	let worktree = options.worktree
	let privateEnv = options.privateEnv
	const requestedSpec = structuredClone(options.plan.requestedSpec)
	const rejectedCredentialNames: string[] = []
	for (const [name, value] of Object.entries(requestedSpec.env)) {
		if (!profileEnvironmentViolation(name, value)) continue
		rejectedCredentialNames.push(name)
		requestedSpec.env[name] = "<rejected-credential>"
	}
	const requestedSpecDigest = requestedReviewEnvironmentDigest({
		spec: requestedSpec,
		caches: options.plan.caches.filter((cache) => requestedSpec.readOnlyCaches.includes(cache.id)),
		toolchain: options.plan.toolchains.find((toolchain) => toolchain.id === requestedSpec.toolchain),
	})
	let effectiveSpec = structuredClone(requestedSpec)
	let selectedCaches: ReviewCacheCatalogEntry[] = []
	let selectedToolchain: ReviewToolchainCatalogEntry | undefined
	let privateDirectories: ReviewEnvironmentReceipt["privateDirectories"] = []
	const setup: ReviewEnvironmentCommandRecord[] = []
	const probes: ReviewEnvironmentProbeRecord[] = []
	const gaps = [...options.plan.gaps]
	let readiness: ReviewEnvironmentReceipt["readiness"] = gaps.length ? "degraded" : "ready"
	let environment: Record<string, string> = {}
	const prepared = {} as ReviewWorktree
	Object.assign(prepared, worktree, { env: {}, readOnlyCachePaths: [] })

	const isolatedEnvironment = () =>
		assembleReviewEnvironment({
			baseEnv: options.baseEnv ?? process.env,
			worktreeEnv: privateEnv,
			specEnv: {},
		})

	const finish = (): { worktree: ReviewWorktree; receipt: ReviewEnvironmentReceipt } => {
		prepared.env = environment
		prepared.readOnlyCachePaths = selectedCaches.map((cache) => cache.path)
		const toolchainId = selectedToolchain?.id
		const toolchainBin = selectedToolchain?.bin ?? []
		const nonHermeticInputs = [
			...selectedCaches.map((cache) => `cache:${cache.id}=${cache.path}`),
			...(toolchainId ? toolchainBin.map((path) => `toolchain:${toolchainId}=${path}`) : []),
		]
		const receipt: ReviewEnvironmentReceipt = {
			schemaVersion: REVIEW_ENVIRONMENT_SCHEMA_VERSION,
			profileApplied: options.plan.profileApplied,
			worktreeId: options.worktreeId,
			worktreePath: worktree.path,
			scratchPath: worktree.scratchDir,
			homePath: worktree.homeDir,
			cachePath: worktree.cacheDir,
			buildPath: worktree.buildDir,
			requestedSpec,
			effectiveSpec,
			requestedSpecDigest,
			receiptDigest: "",
			resolvedCaches: selectedCaches,
			privateDirectories,
			...(selectedToolchain ? { toolchain: selectedToolchain } : {}),
			environment,
			setup,
			probes,
			boundary: options.boundary,
			readiness,
			gaps,
			nonHermeticInputs,
		}
		receipt.receiptDigest = reviewEnvironmentReceiptDigest(receipt)
		prepared.environment = receipt
		return { worktree: prepared, receipt }
	}

	const degrade = async (gap: ReviewEnvironmentGap, required: boolean): Promise<void> => {
		gaps.push(gap)
		readiness = required ? "unready" : "degraded"
		const isolated = await options.resetToIsolated(prepared)
		worktree = isolated.worktree
		privateEnv = isolated.privateEnv
		Object.assign(prepared, worktree)
		effectiveSpec = emptyReviewEnvironmentSpec()
		selectedCaches = []
		selectedToolchain = undefined
		privateDirectories = []
		environment = isolatedEnvironment()
	}

	if (rejectedCredentialNames.length > 0) {
		setup.push(...requestedSpec.setup.map(skippedRecord))
		probes.push(...requestedSpec.probes.map((probe) => ({ id: probe.id, ...skippedRecord(probe) })))
		await degrade(
			{
				kind: "sensitive_environment",
				name: rejectedCredentialNames.join(","),
				note: "Credential-like profile environment entries were rejected before execution; original values were not persisted.",
			},
			true,
		)
		return finish()
	}

	try {
		for (const cacheId of requestedSpec.readOnlyCaches) {
			const configuredCache = options.plan.caches.find((entry) => entry.id === cacheId)
			if (!configuredCache) throw new Error(`Requested read-only cache ${JSON.stringify(cacheId)} is not validated.`)
			const cache = {
				...configuredCache,
				path: await canonicalDirectory(configuredCache.path, `Read-only cache ${cacheId}`),
			}
			for (const forbidden of options.forbiddenCachePaths) {
				const canonicalForbidden = await realpath(forbidden).catch(() => resolve(forbidden))
				if (contained(cache.path, canonicalForbidden) || contained(canonicalForbidden, cache.path)) {
					throw new Error(`Read-only cache ${cacheId} overlaps protected review path ${canonicalForbidden}.`)
				}
			}
			selectedCaches.push(cache)
		}
		if (requestedSpec.toolchain) {
			selectedToolchain = options.plan.toolchains.find((entry) => entry.id === requestedSpec.toolchain)
			if (!selectedToolchain)
				throw new Error(`Requested toolchain ${JSON.stringify(requestedSpec.toolchain)} is not validated.`)
		}
		const privateMap = new Map<string, string>()
		for (const directory of requestedSpec.privateDirs) {
			const root =
				directory.root === "cache"
					? worktree.cacheDir
					: directory.root === "build"
						? worktree.buildDir
						: worktree.scratchDir
			const resolvedPath = await createPrivateDirectory(root, directory)
			for (const cache of selectedCaches) {
				if (contained(cache.path, resolvedPath) || contained(resolvedPath, cache.path)) {
					throw new Error(`Private directory ${directory.id} overlaps read-only cache ${cache.id}.`)
				}
			}
			privateMap.set(directory.id, resolvedPath)
			privateDirectories.push({ ...directory, resolvedPath })
		}
		const cacheMap = new Map(selectedCaches.map((cache) => [cache.id, cache]))
		const specEnv = expandedEnvironment(requestedSpec, cacheMap, privateMap, worktree)
		environment = assembleReviewEnvironment({
			baseEnv: options.baseEnv ?? process.env,
			worktreeEnv: privateEnv,
			specEnv,
			...(selectedToolchain ? { toolchain: selectedToolchain } : {}),
		})
		// Setup and probes execute before finish() attaches the receipt. They
		// must receive the effective env and cache mounts at execution time.
		prepared.env = environment
		prepared.readOnlyCachePaths = selectedCaches.map((cache) => cache.path)
	} catch (error) {
		await degrade(
			{
				kind: "invalid_environment_spec",
				name: options.worktreeId,
				note: `The requested environment was rejected; using an isolated environment: ${error instanceof Error ? error.message : String(error)}`,
			},
			true,
		)
		return finish()
	}

	const needsReadOnlyMounts = selectedCaches.length > 0
	const needsSetupBoundary = requestedSpec.setup.length > 0 || requestedSpec.probes.length > 0
	if (needsSetupBoundary && options.boundary.capabilities.preparationPidNamespace === false) {
		gaps.push({
			kind: "preparation_containment",
			name: options.boundary.kind,
			note: "No private preparation PID namespace is available; live descendant tracking and inherited-marker cleanup are used instead.",
		})
	}
	if (
		(needsReadOnlyMounts && !options.boundary.capabilities.readOnlyMounts) ||
		(needsSetupBoundary &&
			(!options.boundary.capabilities.networkOff || !options.boundary.capabilities.filesystemConfinement))
	) {
		const required =
			requestedSpec.setup.some((command) => command.required) || requestedSpec.probes.some((probe) => probe.required)
		setup.push(...requestedSpec.setup.map(skippedRecord))
		probes.push(...requestedSpec.probes.map((probe) => ({ id: probe.id, ...skippedRecord(probe) })))
		await degrade(
			{
				kind: "environment_unsupported",
				name: options.boundary.kind,
				note: "The execution boundary cannot attest the requested read-only mounts or contained offline preparation; shared caches and setup were not exposed.",
			},
			required || needsReadOnlyMounts,
		)
		return finish()
	}

	for (const command of requestedSpec.setup) {
		if (options.signal?.aborted) {
			setup.push({ ...skippedRecord(command), status: "cancelled", output: "Environment preparation was aborted." })
			await degrade(failureGap("environment_aborted", options.worktreeId, "Environment setup was aborted."), true)
			return finish()
		}
		const execution = await options.execute(prepared, command)
		const result = commandRecord(command, execution)
		setup.push(result)
		if (result.status !== "passed") {
			for (const remaining of requestedSpec.setup.slice(setup.length)) setup.push(skippedRecord(remaining))
			probes.push(...requestedSpec.probes.map((probe) => ({ id: probe.id, ...skippedRecord(probe) })))
			await degrade(
				execution.gap ??
					failureGap(
						options.signal?.aborted ? "environment_aborted" : "setup_failed",
						command.argv[0] ?? "setup",
						`Offline setup did not pass (${result.status}). An isolated fallback replaced its output.`,
					),
				options.signal?.aborted || command.required,
			)
			return finish()
		}
	}
	for (const probe of requestedSpec.probes) {
		if (options.signal?.aborted) {
			probes.push({
				id: probe.id,
				...skippedRecord(probe),
				status: "cancelled",
				output: "Environment preparation was aborted.",
			})
			await degrade(failureGap("environment_aborted", options.worktreeId, "Environment probes were aborted."), true)
			return finish()
		}
		const execution = await options.execute(prepared, probe)
		const result = { id: probe.id, ...commandRecord(probe, execution) }
		probes.push(result)
		if (result.status !== "passed") {
			for (const remaining of requestedSpec.probes.slice(probes.length)) {
				probes.push({ id: remaining.id, ...skippedRecord(remaining) })
			}
			await degrade(
				execution.gap ??
					failureGap(
						options.signal?.aborted ? "environment_aborted" : "probe_failed",
						probe.id,
						`Environment probe did not pass (${result.status}). An isolated fallback replaced preparation output.`,
					),
				options.signal?.aborted || probe.required,
			)
			return finish()
		}
	}
	return finish()
}

function boundedLine(value: string, maximum: number): string {
	return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`
}

/** Short, actual-receipt projection. No setup output or secret-like values are
 * copied into the model prompt. */
export function reviewEnvironmentPromptNote(receipt: ReviewEnvironmentReceipt): string {
	const lines = [
		"REVIEW ENVIRONMENT (actual prepared receipt)",
		`Readiness: ${receipt.readiness}. Boundary: ${receipt.boundary.kind}; networkOff=${receipt.boundary.capabilities.networkOff}; filesystemConfinement=${receipt.boundary.capabilities.filesystemConfinement}; readOnlyMounts=${receipt.boundary.capabilities.readOnlyMounts}.`,
	]
	if (receipt.resolvedCaches.length) {
		lines.push("Read-only caches (shared mutable inputs, not hermetic snapshots):")
		for (const cache of receipt.resolvedCaches) lines.push(`- ${cache.id}: ${cache.path}`)
	} else lines.push("No shared caches are exposed; package/dependency state is isolated to this worktree.")
	if (receipt.privateDirectories.length) {
		lines.push("Private writable directories:")
		for (const directory of receipt.privateDirectories) {
			lines.push(`- ${directory.id} (${directory.root}/${directory.path}): ${directory.resolvedPath}`)
		}
	}
	if (receipt.toolchain) lines.push(`Toolchain ${receipt.toolchain.id} prepends: ${receipt.toolchain.bin.join(", ")}`)
	if (receipt.setup.length || receipt.probes.length) {
		lines.push("Preparation outcomes:")
		for (const record of receipt.setup) lines.push(`- setup ${record.argv.join(" ")}: ${record.status}`)
		for (const record of receipt.probes) lines.push(`- probe ${record.id}: ${record.status}`)
	}
	for (const gap of receipt.gaps) lines.push(`Environment gap ${gap.kind} (${gap.name}): ${gap.note}`)
	if (receipt.boundary.capabilities.networkOff) {
		lines.push(
			"Outbound and loopback network access are denied; loopback-dependent tests fail as environment limitations.",
		)
	} else if (receipt.boundary.kind === "outer-sandbox" || receipt.boundary.kind === "unavailable") {
		lines.push("This receipt does not attest offline or read-only enforcement.")
	}
	const instruction =
		"Do not hand-link or download dependencies and do not use unrelated caches. Report missing tools or dependencies as environment gaps."
	const body = boundedLine(lines.join("\n"), REVIEW_ENVIRONMENT_PROMPT_LIMIT - instruction.length - 1)
	return `${body}\n${instruction}`
}

export const REVIEW_ENVIRONMENT_TESTING = {
	MAX_ENV_VALUE_BYTES,
	REVIEW_ENVIRONMENT_OUTPUT_LIMIT,
	REVIEW_ENVIRONMENT_PROMPT_LIMIT,
	canonicalDirectory,
	contained,
}
