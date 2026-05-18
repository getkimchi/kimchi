/**
 * package-resources.ts — Discover resource directories contributed by installed
 * kimchi extension packages.
 *
 * Each pi package can ship its own `skills/`, `agents/`, etc. dirs alongside
 * the standard pi resources. This helper enumerates installed packages via
 * pi's `DefaultPackageManager` and returns the subset that have a given
 * resource subdirectory present on disk.
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
import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent"

export function getInstalledPackageResourceDirs(cwd: string, subdir: string): string[] {
	try {
		const agentDir = getAgentDir()
		const settingsManager = SettingsManager.create(cwd, agentDir)
		const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager })
		const packages = pm.listConfiguredPackages()
		const dirs: string[] = []
		for (const pkg of packages) {
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
