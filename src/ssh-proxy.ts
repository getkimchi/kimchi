import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveAuxiliaryFilesDir } from "./auxiliary-files/resolver.js"
import { readApiKeyFromConfigFile } from "./config.js"

export function findProxyHelper(override?: string): string {
	const explicit = override ?? process.env.KIMCHI_PROXY_HELPER
	if (explicit) {
		return explicit
	}

	const shareDir = resolveAuxiliaryFilesDir(process.env, process.env.HOME ?? "", process.execPath)
	const bundled = join(shareDir, "bin", "proxy-helper")
	if (existsSync(bundled)) {
		return bundled
	}

	// Fall back to PATH (useful in dev / non-binary runs)
	for (const dir of (process.env.PATH ?? "").split(":")) {
		const candidate = join(dir, "proxy-helper")
		if (existsSync(candidate)) {
			return candidate
		}
	}

	throw new Error(
		`proxy-helper binary not found. Checked bundled path: ${bundled}\nRun 'make copy-for-dev' in tools/proxy-helper/ or ensure proxy-helper is on PATH.`,
	)
}

/**
 * Replaces the current process with proxy-helper via process.execve.
 * The OS swaps the process image — this never returns.
 */
export function isProxyMode(args: string[]): boolean {
	const idx = args.indexOf("--ssh-proxy")
	return idx !== -1 && !!args[idx + 1] && !args[idx + 1].startsWith("-")
}

export function runProxy(sessionIDOrSandboxURL: string, proxyHelperPath?: string): never {
	const bin = findProxyHelper(proxyHelperPath)
	const apiKey = process.env.KIMCHI_API_KEY ?? readApiKeyFromConfigFile()
	const env: Record<string, string> = { ...(process.env as Record<string, string>) }
	if (apiKey) {
		env.KIMCHI_API_KEY = apiKey
	}

	const result = spawnSync(bin, ["ssh-proxy", sessionIDOrSandboxURL], {
		stdio: "inherit",
		shell: false,
		env,
	})

	process.exit(result.status ?? 1)
}
