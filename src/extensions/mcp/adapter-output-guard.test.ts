import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, it } from "vitest"

const require = createRequire(import.meta.url)

/**
 * Kimchi lowers the adapter's MCP output-guard default from the adapter's
 * 50 KB (the read tool's cap) to 12 KB via patches/pi-mcp-adapter@5.3.1.patch:
 * five parallel ~50 KB MCP results ≈ 64k tokens, which overflowed the remaining
 * context headroom on 256k-window sessions (12 KB keeps such bursts within it).
 * The constant lives inside the patched dependency and is not exported, so this
 * test asserts the patched source directly and fails loudly when the adapter
 * version bumps before the patch is re-ported.
 */
describe("pi-mcp-adapter output guard patch", () => {
	it("defaults the model-facing MCP output cap to 12 KB", () => {
		const adapterDir = dirname(require.resolve("pi-mcp-adapter"))
		const source = readFileSync(join(adapterDir, "mcp-output-guard.ts"), "utf8")
		const match = source.includes("export const DEFAULT_MCP_OUTPUT_MAX_BYTES = 12 * 1024;")
		if (!match) {
			throw new Error(
				"DEFAULT_MCP_OUTPUT_MAX_BYTES is not 12 * 1024 in the installed pi-mcp-adapter — the adapter version changed without re-porting patches/pi-mcp-adapter@5.3.1.patch",
			)
		}
	})
})
