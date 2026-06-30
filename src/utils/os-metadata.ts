import { readFileSync } from "node:fs"
import { arch, platform } from "node:os"

/**
 * Detect whether the current process is running under WSL (Windows Subsystem
 * for Linux).
 *
 * First checks the `WSL_DISTRO_NAME` / `WSLENV` environment variables; if
 * neither is set, falls back to reading `/proc/version` and testing for a
 * Microsoft/WSL signature.
 *
 * Extracted into its own module so that OS-level metadata helpers (such as a
 * future `getOsMetadata()`) have a clean home that does not risk circular
 * imports with clipboard or telemetry code.
 */
export function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true
	}

	try {
		const release = readFileSync("/proc/version", "utf-8")
		return /microsoft|wsl/i.test(release)
	} catch {
		return false
	}
}

// ---------------------------------------------------------------------------
// Arch mapping (Node → Go-compatible names for historical compatibility)
// ---------------------------------------------------------------------------

export function goArch(): string {
	const a = arch()
	switch (a) {
		case "x64":
			return "amd64"
		case "ia32":
			return "386"
		default:
			return a
	}
}

// ---------------------------------------------------------------------------
// OS metadata — produces the four telemetry OS keys
// ---------------------------------------------------------------------------

export interface OsMetadata {
	"telemetry.os": string
	"telemetry.arch": string
	"telemetry.host_os": string
	"telemetry.is_wsl": boolean
}

export function getOsMetadata(): OsMetadata {
	const wsl = isWSL()
	const os = platform()
	return {
		"telemetry.os": os,
		"telemetry.arch": goArch(),
		"telemetry.host_os": wsl ? "win32" : os,
		"telemetry.is_wsl": wsl,
	}
}
