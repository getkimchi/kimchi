// extensions/lsp/servers.ts
import fs from "node:fs"
import path from "node:path"
import type { ServerConfig } from "./types.js"

const SERVERS: ServerConfig[] = [
	{
		name: "typescript-language-server",
		command: "typescript-language-server",
		args: ["--stdio"],
		extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
	},
	{
		name: "gopls",
		command: "gopls",
		args: [],
		extensions: ["go"],
	},
]

function exists(cmd: string): boolean {
	try {
		// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
		const result = (globalThis as any).Bun.spawnSync(["which", cmd], { stdout: "pipe", stderr: "pipe" })
		return result.exitCode === 0
	} catch {
		return false
	}
}

/** Returns all LSP servers whose binary is available on PATH. */
export function detectServers(_cwd: string): ServerConfig[] {
	return SERVERS.filter((s) => exists(s.command))
}

/** Get the server config for a specific file path, or null if no server applies. */
export function serverForFile(filePath: string, servers: ServerConfig[]): ServerConfig | null {
	const ext = path.extname(filePath).slice(1).toLowerCase()
	return servers.find((s) => s.extensions.includes(ext)) ?? null
}

const ROOT_MARKERS: Record<string, string[]> = {
	gopls: ["go.mod"],
	"typescript-language-server": ["tsconfig.json", "package.json"],
}

/**
 * Walk up from filePath to find the nearest project root for the given server.
 * Clamps to sessionCwd — never escapes above it.
 * Falls back to path.dirname(filePath) if no marker found.
 */
export function findRoot(filePath: string, serverName: string, sessionCwd: string): string {
	const markers = ROOT_MARKERS[serverName] ?? []
	let dir = path.dirname(filePath)
	const boundary = sessionCwd

	while (true) {
		if (markers.some((m) => fs.existsSync(path.join(dir, m)))) return dir
		if (dir === boundary || dir === path.dirname(dir)) break
		dir = path.dirname(dir)
	}

	// If no marker found within sessionCwd, use file's own directory
	return path.dirname(filePath)
}
