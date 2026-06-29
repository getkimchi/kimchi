import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import { resolveAuxiliaryFilesDir } from "./auxiliary-files/resolver.js"
import { readApiKeyFromConfigFile } from "./config.js"

interface FindProxyHelperOptions {
	env?: NodeJS.ProcessEnv
	home?: string
	execPath?: string
	platform?: NodeJS.Platform
	pathDelimiter?: string
	exists?: (path: string) => boolean
}

function proxyHelperNames(platform: NodeJS.Platform): string[] {
	return platform === "win32" ? ["proxy-helper.exe", "proxy-helper"] : ["proxy-helper"]
}

export function findProxyHelper(override?: string, options: FindProxyHelperOptions = {}): string {
	const env = options.env ?? process.env
	const exists = options.exists ?? existsSync
	const explicit = override ?? env.KIMCHI_PROXY_HELPER
	if (explicit) {
		return explicit
	}

	const platform = options.platform ?? process.platform
	const names = proxyHelperNames(platform)
	const shareDir = resolveAuxiliaryFilesDir(env, options.home ?? env.HOME ?? "", options.execPath ?? process.execPath)
	const bundledCandidates = names.map((name) => join(shareDir, "bin", name))
	for (const bundled of bundledCandidates) {
		if (exists(bundled)) {
			return bundled
		}
	}

	// Fall back to PATH (useful in dev / non-binary runs)
	const pathDelimiter = options.pathDelimiter ?? delimiter
	for (const dir of (env.PATH ?? "").split(pathDelimiter)) {
		if (!dir) continue
		for (const name of names) {
			const candidate = join(dir, name)
			if (exists(candidate)) {
				return candidate
			}
		}
	}

	throw new Error(
		`proxy-helper binary not found. Checked bundled paths: ${bundledCandidates.join(", ")}\nRun 'node scripts/build-proxy-helper.js' or ensure proxy-helper is on PATH.`,
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
