/**
 * package-resources.ts — Discover resource directories contributed by installed
 * extension packages.
 *
 * Each pi package can ship its own `skills/`, `agents/`, etc. dirs alongside
 * the standard pi resources. This helper enumerates Kimchi-native packages
 * plus original Pi packages when Pi package lookup is enabled, then returns
 * the subset that have a given resource subdirectory present on disk.
 *
 * Used by:
 *   - `custom-agents.ts` — to load <pkg>/agents/*.md
 *   - `extensions/prompt-construction/prompt-enrichment.ts` — to load <pkg>/skills/...
 *
 * Errors are swallowed (with `console.warn`) — a single misconfigured package
 * should not block the entire harness.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { getConfiguredPackageResourceRecords } from "../../resources/package-resources.js"
import { isResourceEnabled } from "../../resources/store.js"

export function getInstalledPackageResourceDirs(cwd: string, subdir: string): string[] {
	try {
		const dirs: string[] = []
		for (const pkg of getConfiguredPackageResourceRecords(cwd)) {
			if (!isResourceEnabled(pkg.id)) continue
			if (!pkg.installedPath) continue
			const candidate = join(pkg.installedPath, subdir)
			if (existsSync(candidate)) dirs.push(candidate)
		}
		return dirs
	} catch (err) {
		console.warn(`Failed to discover package ${subdir} dirs: ${err instanceof Error ? err.message : String(err)}`)
		return []
	}
}
