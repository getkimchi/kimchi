import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import type { PackageSource } from "@earendil-works/pi-coding-agent"

export const PI_PACKAGE_LOOKUP_RESOURCE_ID = "extensions.pi-package-lookup"

const ORIGINAL_PI_CONFIG_DIR_NAME = ".pi"
const ORIGINAL_PI_MANAGER = Symbol.for("kimchi.originalPiPackageManager")

type PackageScope = "user" | "project"
type SourceScope = PackageScope | "temporary"
type PackageOrigin = "kimchi" | "pi"
type SettingsScope = "global" | "project"

interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void
}

export interface ConfiguredPackageEntry {
	source: string
	scope: PackageScope
	filtered: boolean
	installedPath?: string
	origin?: PackageOrigin
}

interface PackageSourceEntry {
	pkg: PackageSource
	scope: PackageScope
}

interface PathMetadata {
	source: string
	scope: SourceScope
	origin: "package" | "top-level"
	baseDir?: string
}

interface ResolvedResource {
	path: string
	enabled: boolean
	metadata: PathMetadata
}

export interface ResolvedPaths {
	extensions: ResolvedResource[]
	skills: ResolvedResource[]
	prompts: ResolvedResource[]
	themes: ResolvedResource[]
}

type PackageManagerInternals = {
	cwd: string
	agentDir: string
	settingsManager: SettingsManager
	[ORIGINAL_PI_MANAGER]?: boolean
	createAccumulator(): unknown
	dedupePackages(packages: PackageSourceEntry[]): PackageSourceEntry[]
	getPackageIdentity(source: string, scope?: SourceScope): string
	resolvePackageSources(
		sources: PackageSourceEntry[],
		accumulator: unknown,
		onMissing?: (source: string) => Promise<"install" | "skip" | "error">,
	): Promise<void>
	toResolvedPaths(accumulator: unknown): ResolvedPaths
	getNpmInstallRoot(scope: SourceScope, temporary: boolean): string
	getManagedNpmInstallPath(source: { name: string }, scope: SourceScope): string
	getGitInstallPath(source: { host: string; path: string }, scope: SourceScope): string
	getGitInstallRoot(scope: SourceScope): string | undefined
	getBaseDirForScope(scope: SourceScope): string
}

class OriginalPiSettingsStorage implements SettingsStorage {
	private readonly globalSettingsPath: string
	private readonly projectSettingsPath: string

	constructor(cwd: string, agentDir: string) {
		this.globalSettingsPath = join(resolve(agentDir), "settings.json")
		this.projectSettingsPath = join(resolve(cwd), ORIGINAL_PI_CONFIG_DIR_NAME, "settings.json")
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath
		const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined
		const next = fn(current)
		if (next === undefined) return
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, next, "utf-8")
	}
}

export function getOriginalPiAgentDir(): string {
	const explicitAgentDir = process.env.KIMCHI_ORIGINAL_PI_CODING_AGENT_DIR
	if (explicitAgentDir) return resolveTilde(explicitAgentDir)

	const piAgentDir = process.env.PI_CODING_AGENT_DIR
	if (piAgentDir && !isKimchiAgentDir(piAgentDir)) return resolveTilde(piAgentDir)

	return resolveTilde(join(homedir(), ORIGINAL_PI_CONFIG_DIR_NAME, "agent"))
}

export function isOriginalPiPackageLookupEnabled(settingsPath = kimchiSettingsPath()): boolean {
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as { resources?: Record<string, unknown> }
		const value = raw.resources?.[PI_PACKAGE_LOOKUP_RESOURCE_ID]
		return typeof value === "boolean" ? value : false
	} catch {
		return false
	}
}

export function getOriginalPiConfiguredPackages(cwd = process.cwd()): ConfiguredPackageEntry[] {
	if (!isOriginalPiPackageLookupEnabled() || isOriginalPiAgentDirSameAsKimchi()) return []
	const { packageManager } = createOriginalPiPackageManager(cwd)
	return packageManager.listConfiguredPackages().map((pkg) => ({ ...pkg, origin: "pi" as const }))
}

export function getPackageManagerPackageIdentities(packageManager: DefaultPackageManager): Set<string> {
	const pm = asPackageManagerInternals(packageManager)
	const settingsManager = pm.settingsManager
	if (!settingsManager) return new Set()

	const packages: PackageSourceEntry[] = [
		...(settingsManager.getProjectSettings().packages ?? []).map((pkg) => ({ pkg, scope: "project" as const })),
		...(settingsManager.getGlobalSettings().packages ?? []).map((pkg) => ({ pkg, scope: "user" as const })),
	]
	const deduped = typeof pm.dedupePackages === "function" ? pm.dedupePackages(packages) : packages
	return new Set(
		deduped.map((entry) =>
			pm.getPackageIdentity(typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source, entry.scope),
		),
	)
}

export async function resolveOriginalPiPackageResources(
	cwd: string,
	nativePackageIdentities: ReadonlySet<string>,
): Promise<ResolvedPaths> {
	if (!isOriginalPiPackageLookupEnabled() || isOriginalPiAgentDirSameAsKimchi()) return emptyResolvedPaths()

	const { packageManager } = createOriginalPiPackageManager(cwd)
	const pm = asPackageManagerInternals(packageManager)
	const settingsManager = pm.settingsManager
	const packages: PackageSourceEntry[] = [
		...(settingsManager.getProjectSettings().packages ?? []).map((pkg) => ({ pkg, scope: "project" as const })),
		...(settingsManager.getGlobalSettings().packages ?? []).map((pkg) => ({ pkg, scope: "user" as const })),
	]
	const deduped = pm.dedupePackages(packages).filter((entry) => {
		const source = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source
		return !nativePackageIdentities.has(pm.getPackageIdentity(source, entry.scope))
	})

	const accumulator = pm.createAccumulator()
	await pm.resolvePackageSources(deduped, accumulator, async () => "skip")
	return pm.toResolvedPaths(accumulator)
}

export function mergeResolvedPaths(primary: ResolvedPaths, secondary: ResolvedPaths): ResolvedPaths {
	return {
		extensions: mergeResolvedResources(primary.extensions, secondary.extensions),
		skills: mergeResolvedResources(primary.skills, secondary.skills),
		prompts: mergeResolvedResources(primary.prompts, secondary.prompts),
		themes: mergeResolvedResources(primary.themes, secondary.themes),
	}
}

export function isOriginalPiPackageManager(packageManager: DefaultPackageManager): boolean {
	return asPackageManagerInternals(packageManager)[ORIGINAL_PI_MANAGER] === true
}

function createOriginalPiPackageManager(cwd: string): { agentDir: string; packageManager: DefaultPackageManager } {
	const agentDir = getOriginalPiAgentDir()
	const settingsManager = SettingsManager.fromStorage(new OriginalPiSettingsStorage(cwd, agentDir))
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager })
	patchOriginalPiProjectPaths(packageManager, cwd)
	return { agentDir, packageManager }
}

function patchOriginalPiProjectPaths(packageManager: DefaultPackageManager, cwd: string): void {
	const pm = asPackageManagerInternals(packageManager)
	pm[ORIGINAL_PI_MANAGER] = true

	const originalGetNpmInstallRoot = pm.getNpmInstallRoot.bind(pm)
	pm.getNpmInstallRoot = (scope, temporary) =>
		scope === "project"
			? join(resolve(cwd), ORIGINAL_PI_CONFIG_DIR_NAME, "npm")
			: originalGetNpmInstallRoot(scope, temporary)

	const originalGetManagedNpmInstallPath = pm.getManagedNpmInstallPath.bind(pm)
	pm.getManagedNpmInstallPath = (source, scope) =>
		scope === "project"
			? join(resolve(cwd), ORIGINAL_PI_CONFIG_DIR_NAME, "npm", "node_modules", source.name)
			: originalGetManagedNpmInstallPath(source, scope)

	const originalGetGitInstallPath = pm.getGitInstallPath.bind(pm)
	pm.getGitInstallPath = (source, scope) =>
		scope === "project"
			? join(resolve(cwd), ORIGINAL_PI_CONFIG_DIR_NAME, "git", source.host, source.path)
			: originalGetGitInstallPath(source, scope)

	const originalGetGitInstallRoot = pm.getGitInstallRoot.bind(pm)
	pm.getGitInstallRoot = (scope) =>
		scope === "project" ? join(resolve(cwd), ORIGINAL_PI_CONFIG_DIR_NAME, "git") : originalGetGitInstallRoot(scope)

	const originalGetBaseDirForScope = pm.getBaseDirForScope.bind(pm)
	pm.getBaseDirForScope = (scope) =>
		scope === "project" ? join(resolve(cwd), ORIGINAL_PI_CONFIG_DIR_NAME) : originalGetBaseDirForScope(scope)
}

function asPackageManagerInternals(packageManager: DefaultPackageManager): PackageManagerInternals {
	return packageManager as unknown as PackageManagerInternals
}

function mergeResolvedResources(primary: ResolvedResource[], secondary: ResolvedResource[]): ResolvedResource[] {
	const seen = new Set(primary.map((resource) => resolve(resource.path)))
	return [
		...primary,
		...secondary.filter((resource) => {
			const key = resolve(resource.path)
			if (seen.has(key)) return false
			seen.add(key)
			return true
		}),
	]
}

function emptyResolvedPaths(): ResolvedPaths {
	return { extensions: [], skills: [], prompts: [], themes: [] }
}

function isOriginalPiAgentDirSameAsKimchi(): boolean {
	try {
		return resolve(getOriginalPiAgentDir()) === resolve(getKimchiAgentDir())
	} catch {
		return false
	}
}

function getKimchiAgentDir(): string {
	return process.env.KIMCHI_CODING_AGENT_DIR
		? resolve(process.env.KIMCHI_CODING_AGENT_DIR)
		: join(homedir(), ".config", "kimchi", "harness")
}

function isKimchiAgentDir(path: string): boolean {
	try {
		return resolveTilde(path) === getKimchiAgentDir()
	} catch {
		return false
	}
}

function kimchiSettingsPath(): string {
	return join(getKimchiAgentDir(), "settings.json")
}

function resolveTilde(path: string): string {
	if (path === "~") return homedir()
	if (path.startsWith("~/")) return join(homedir(), path.slice(2))
	return resolve(path)
}
