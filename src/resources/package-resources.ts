import { createHash } from "node:crypto"
import { resolve, sep } from "node:path"
import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent"
import type { ResourceDefinition } from "./types.js"

interface ConfiguredPackageEntry {
	source: string
	scope: "user" | "project"
	filtered: boolean
	installedPath?: string
}

export interface PackageResourceRecord {
	id: string
	source: string
	scope: ConfiguredPackageEntry["scope"]
	installedPath?: string
}

export function discoverPackageResources(cwd = process.cwd()): ResourceDefinition[] {
	return getConfiguredPackageResourceRecords(cwd).map((record) => ({
		id: record.id,
		kind: "plugins",
		label: `Package: ${packageDisplayName(record.source)}`,
		description: `Enable Pi package ${record.source}.`,
		defaultEnabled: true,
		restartRequired: true,
	}))
}

export function getConfiguredPackageResourceRecords(cwd = process.cwd()): PackageResourceRecord[] {
	try {
		const agentDir = getAgentDir()
		const settingsManager = SettingsManager.create(cwd, agentDir)
		const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager })
		return packageResourceRecordsFromConfiguredPackages(pm.listConfiguredPackages())
	} catch (err) {
		console.warn(`Failed to discover package resources: ${err instanceof Error ? err.message : String(err)}`)
		return []
	}
}

export function packageResourceRecordsFromConfiguredPackages(
	packages: readonly ConfiguredPackageEntry[],
): PackageResourceRecord[] {
	const recordsById = new Map<string, PackageResourceRecord>()
	const seenSources = new Map<string, PackageResourceRecord>()

	for (const pkg of packages) {
		const sourceKey = pkg.source.trim()
		if (!sourceKey) continue

		const sourceRecord = seenSources.get(sourceKey)
		if (sourceRecord) {
			if (pkg.scope === "project") {
				seenSources.set(sourceKey, {
					...sourceRecord,
					scope: pkg.scope,
					installedPath: pkg.installedPath ?? sourceRecord.installedPath,
				})
			}
			continue
		}

		const baseId = packageResourceId(pkg.source)
		const id =
			recordsById.has(baseId) && recordsById.get(baseId)?.source !== pkg.source
				? `${baseId}-${shortHash(pkg.source)}`
				: baseId
		const record: PackageResourceRecord = {
			id,
			source: pkg.source,
			scope: pkg.scope,
			installedPath: pkg.installedPath,
		}
		seenSources.set(sourceKey, record)
		recordsById.set(id, record)
	}

	return [...seenSources.values()].sort((a, b) => a.id.localeCompare(b.id))
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

function packageDisplayName(source: string): string {
	const trimmed = source.trim()
	if (trimmed.startsWith("npm:")) return trimmed.slice("npm:".length)
	return trimmed
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
