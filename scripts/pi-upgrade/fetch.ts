import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type RunConfig, readJson, writeJson } from "./config.ts"
import type { SettleResult } from "./settle.ts"

/** Pi packages released in lockstep; all are pinned to the same version in package.json. */
export const PACKAGES = ["pi-coding-agent", "pi-ai", "pi-tui", "pi-codemode"] as const
export type PiPackage = (typeof PACKAGES)[number]

/** Extracted npm tarball root (the tarball's `package/` dir). */
export function pkgDir(cfg: RunConfig, pkg: string, version: string): string {
	return join(cfg.outDir, "pkgs", `${pkg}@${version}`, "package")
}

export interface FetchResult {
	versions: string[]
	/** `<pkg>@<version>` not published (e.g. a package newer than the baseline). */
	missing: string[]
}

function extract(cfg: RunConfig, pkg: string, version: string): boolean {
	const dest = join(cfg.outDir, "pkgs", `${pkg}@${version}`)
	if (existsSync(join(dest, "package"))) return true
	const tmp = mkdtempSync(join(tmpdir(), "pi-upgrade-pack-"))
	try {
		const name = execFileSync(
			"npm",
			["pack", `@earendil-works/${pkg}@${version}`, "--pack-destination", tmp, "--silent"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		)
			.trim()
			.split("\n")
			.pop()
		if (!name) return false
		mkdirSync(dest, { recursive: true })
		execFileSync("tar", ["-xzf", join(tmp, name), "-C", dest])
		return true
	} catch {
		return false
	} finally {
		rmSync(tmp, { recursive: true, force: true })
	}
}

export async function runFetch(cfg: RunConfig): Promise<FetchResult> {
	const { baseline, chain } = readJson<SettleResult>(cfg, "settle")
	const versions = [baseline, ...chain]
	const missing: string[] = []
	for (const version of versions) {
		for (const pkg of PACKAGES) {
			if (!extract(cfg, pkg, version)) missing.push(`${pkg}@${version}`)
		}
	}
	const result = { versions, missing }
	writeJson(cfg, "fetch", result)
	return result
}
