// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { isBunBinary } from "../../env.js"

export const MCP_KEYRING_HELPER_COMMAND = "mcp-keyring-helper"
const RECOVERY_NODE_ENV = "PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE"
const RECOVERY_HELPER_ENV = "PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER"

export function configureMcpKeyringRecoveryHelper(): void {
	if (!isBunBinary || process.platform !== "linux") return
	// These overrides form a pair. Keep user-supplied runtimes/helpers together.
	if (process.env[RECOVERY_NODE_ENV]?.trim() || process.env[RECOVERY_HELPER_ENV]?.trim()) return
	// The adapter executes: keyctl session - <runtime> <helper>.
	process.env[RECOVERY_NODE_ENV] = process.execPath
	process.env[RECOVERY_HELPER_ENV] = MCP_KEYRING_HELPER_COMMAND
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
