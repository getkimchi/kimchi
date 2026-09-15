/**
 * agent-colab installer — bridges the standalone pi package into kimchi.
 *
 * The extension's single source of truth is the `pi-agent-colab` npm package
 * (github:getkimchi/pi-agent-colab, pinned via package.json). This installer
 * mirrors its TypeScript files into pi's *discovered* extensions dir
 * (`<agentDir>/extensions/agent-colab`) and stamps the installed version —
 * the same write-into-extensions-dir pattern as the herdr bridge. pi's
 * extension loader aliases bare imports (typebox, pi-tui,
 * @earendil-works/pi-coding-agent) to its bundled copies, so the mirrored
 * files resolve without any node_modules of their own.
 *
 * Runs once per startup, before extension discovery: same version stamp →
 * no-op; missing/changed → re-mirror. Best-effort by design — a failed sync
 * downgrades to "no collaboration", never a broken startup.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { isBunBinary } from "../env.js"

const VERSION_STAMP = ".kimchi-agent-colab-version"

/** Locate the installed pi-agent-colab package directory. */
export function resolveAgentColabSourceDir(): string | undefined {
	if (isBunBinary) {
		// Compiled binary: deps live inside the pi package dir (npm layout).
		const packageDir = process.env.PI_PACKAGE_DIR
		if (!packageDir) return undefined
		const candidate = join(packageDir, "node_modules", "pi-agent-colab")
		return existsSync(join(candidate, "package.json")) ? candidate : undefined
	}
	try {
		// Dev (repo checkout): resolve through the repo's node_modules.
		const require = createRequire(import.meta.url)
		return dirname(require.resolve("pi-agent-colab/package.json"))
	} catch {
		return undefined
	}
}

function versionOf(sourceDir: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8")) as { version?: unknown }
		return typeof pkg.version === "string" ? pkg.version : undefined
	} catch {
		return undefined
	}
}

/**
 * Mirror the package's extension files into `<agentDir>/extensions/agent-colab`.
 * Skips tests and non-TS assets; re-mirrors when the version stamp changes.
 */
export function ensureAgentColabExtension(agentDir: string, opts?: { sourceDir?: string; targetDir?: string }): void {
	try {
		const sourceDir = opts?.sourceDir ?? resolveAgentColabSourceDir()
		if (!sourceDir) {
			console.warn("agent-colab: pi-agent-colab package not found; collaboration unavailable this session.")
			return
		}
		const version = versionOf(sourceDir)
		if (!version) {
			console.warn("agent-colab: pi-agent-colab package has no readable version; skipping sync.")
			return
		}

		const targetDir = opts?.targetDir ?? join(agentDir, "extensions", "agent-colab")
		const stampPath = join(targetDir, VERSION_STAMP)
		let needsSync = true
		try {
			needsSync = readFileSync(stampPath, "utf8") !== version || !existsSync(join(targetDir, "index.ts"))
		} catch {
			needsSync = true
		}
		if (!needsSync) return

		mkdirSync(targetDir, { recursive: true })
		for (const file of readdirSync(sourceDir)) {
			// Extension sources only — tests and assets stay in the package.
			if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
			copyFileSync(join(sourceDir, file), join(targetDir, file))
		}
		writeFileSync(stampPath, version)
		console.warn(`agent-colab: synced extension v${version} → ${targetDir}`)
	} catch (err) {
		console.warn(
			`agent-colab: failed to sync extension (${err instanceof Error ? err.message : String(err)}); continuing without it.`,
		)
	}
}
