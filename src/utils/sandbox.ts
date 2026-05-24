import { homedir, userInfo } from "node:os"

/**
 * Layered detection for CASTAI sandbox cluster environments.
 *
 * Used by extensions that behave differently when running inside a
 * sandboxed worker (e.g. activity bus, permissions bypass, etc.).
 *
 * Detection layers (checked in order, first true wins):
 *   1. KIMCHI_SANDBOX env var ("1" or "true", case-insensitive) — explicit sentinel set by container orchestrator
 *   2. Security fallback: homedir() === "/home/sandbox" AND username === "sandbox"
 *      — both must match to avoid false positives if user or home path changes
 */
export function isInSandboxCluster(): boolean {
	if (process.env.KIMCHI_SANDBOX === "1" || process.env.KIMCHI_SANDBOX?.toLowerCase() === "true") return true
	// Security fallback: both home and user must match to confirm sandbox environment.
	// Single signal alone is ignored to prevent false positives on user switch/path change.
	try {
		if (homedir() === "/home/sandbox" && userInfo().username === "sandbox") return true
	} catch {
		// userInfo() throws if UID has no /etc/passwd entry (common in hardened containers)
	}
	return false
}
