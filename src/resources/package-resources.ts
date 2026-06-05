import { createHash } from "node:crypto"
import { resolve, sep } from "node:path"
import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent"
import {
	type ConfiguredPackageEntry,
	getOriginalPiConfiguredPackages,
	isOriginalPiPackageLookupEnabled,
} from "../extensions/pi-package-lookup/index.js"
import type { ResourceDefinition } from "./types.js"

export interface PackageResourceRecord {
	id: string
	source: string
	scope: ConfiguredPackageEntry["scope"]
	origin: NonNullable<ConfiguredPackageEntry["origin"]>
	installedPath?: string
}

export function discoverPackageResources(cwd = process.cwd()): ResourceDefinition[] {
	return getConfiguredPackageResourceRecords(cwd).map((record) => ({
		id: record.id,
		kind: "plugins",
		label: `Package: ${packageDisplayName(record.source)}`,
		description:
			record.origin === "pi"
				? `Enable package ${record.source} discovered from the original pi CLI.`
				: `Enable Kimchi package ${record.source}.`,
		defaultEnabled: true,
		restartRequired: true,
	}))
}

export function getConfiguredPackageResourceRecords(cwd = process.cwd()): PackageResourceRecord[] {
	try {
		const agentDir = getAgentDir()
		const settingsManager = SettingsManager.create(cwd, agentDir)
		const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager })
		const nativePackages = pm
			.listConfiguredPackages()
			.map((pkg): ConfiguredPackageEntry => ({ ...pkg, origin: "kimchi" }))
		const piPackages = isOriginalPiPackageLookupEnabled() ? getOriginalPiConfiguredPackages(cwd) : []
		return packageResourceRecordsFromConfiguredPackages([...nativePackages, ...piPackages])
	} catch (err) {
		console.warn(`Failed to discover package resources: ${err instanceof Error ? err.message : String(err)}`)
		return []
	}
}

export function packageResourceRecordsFromConfiguredPackages(
	packages: readonly ConfiguredPackageEntry[],
): PackageResourceRecord[] {
	const dedupedByIdentity = new Map<string, ConfiguredPackageEntry>()
	for (const pkg of packages) {
		const source = pkg.source.trim()
		if (!source) continue
		const key = packageDedupKey(source, pkg.scope, pkg.origin ?? "kimchi")
		const existing = dedupedByIdentity.get(key)
		if (!existing || packagePrecedence(pkg) < packagePrecedence(existing)) dedupedByIdentity.set(key, pkg)
	}

	const recordsById = new Map<string, PackageResourceRecord>()

	for (const pkg of dedupedByIdentity.values()) {
		const sourceKey = pkg.source.trim()
		if (!sourceKey) continue

		const baseId = packageResourceId(pkg.source)
		const id =
			recordsById.has(baseId) && recordsById.get(baseId)?.source !== pkg.source
				? `${baseId}-${shortHash(pkg.source)}`
				: baseId
		const record: PackageResourceRecord = {
			id,
			source: pkg.source,
			scope: pkg.scope,
			origin: pkg.origin ?? "kimchi",
			installedPath: pkg.installedPath,
		}
		recordsById.set(id, record)
	}

	return [...recordsById.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function packageResourceId(source: string): string {
	return `plugins.package.${slugPackageSource(source)}`
}

export function isPathInsidePackage(path: string | undefined, record: PackageResourceRecord): boolean {
	if (!path || !record.installedPath) return false
	const normalizedPath = resolve(path)
	const packageRoot = resolve(record.installedPath)
	return normalizedPath === packageRoot || normalizedPath.startsWith(`${packageRoot}${sep}`)
}

export function packageSourcesMatch(left: string | undefined, right: string | undefined): boolean {
	if (typeof left !== "string" || typeof right !== "string") return false
	const leftSource = left.trim()
	const rightSource = right.trim()
	if (!leftSource || !rightSource) return false
	if (leftSource === rightSource) return true

	const leftNpmName = npmPackageIdentity(leftSource)
	const rightNpmName = npmPackageIdentity(rightSource)
	return leftNpmName !== undefined && leftNpmName === rightNpmName
}

function packageDisplayName(source: string): string {
	const trimmed = source.trim()
	if (trimmed.startsWith("npm:")) return trimmed.slice("npm:".length)
	return trimmed
}

function packagePrecedence(pkg: ConfiguredPackageEntry): number {
	const scopeRank = pkg.scope === "project" ? 0 : 10
	const originRank = (pkg.origin ?? "kimchi") === "kimchi" ? 0 : 1
	return scopeRank + originRank
}

function packageDedupKey(source: string, scope: ConfiguredPackageEntry["scope"], origin: string): string {
	if (source.startsWith("npm:")) return `npm:${npmPackageName(source.slice("npm:".length))}`
	if (source.startsWith("git:")) return source
	if (/^[a-z]+:\/\//i.test(source) || /^[^@\s]+@[^:\s]+:.+/.test(source)) return source
	return `${origin}:${scope}:${source}`
}

function npmPackageName(spec: string): string {
	const slash = spec.indexOf("/")
	const versionAt = spec.startsWith("@") ? spec.indexOf("@", Math.max(slash, 0) + 1) : spec.indexOf("@")
	return versionAt > 0 ? spec.slice(0, versionAt) : spec
}

function npmPackageIdentity(source: string): string | undefined {
	const spec = source.startsWith("npm:") ? source.slice("npm:".length) : source
	if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[^/\s]+)?$/i.test(spec)) return undefined
	return npmPackageName(spec).toLowerCase()
}

function slugPackageSource(source: string): string {
	const slug = source
		.trim()
		.toLowerCase()
		.replace(/^npm:/, "npm-")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
	return slug || "package"
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8)
}
