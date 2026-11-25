import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)

/**
 * Kimchi lowers the adapter's MCP output-guard default from the adapter's
 * 50 KB (the read tool's cap) to 12 KB via patches/pi-mcp-adapter@5.3.2.patch:
 * five parallel ~50 KB MCP results ≈ 64k tokens, which overflowed the remaining
 * context headroom on 256k-window sessions (12 KB keeps such bursts within it).
 * The constant lives inside the patched dependency and is not exported, so this
 * test asserts the patched source directly and fails loudly when the adapter
 * version bumps before the patch is re-ported.
 */
describe("pi-mcp-adapter output guard patch", () => {
	it("defaults the model-facing MCP output cap to 12 KB", async () => {
		const adapterDir = dirname(require.resolve("pi-mcp-adapter"))
		const { resolveMcpOutputGuardOptions } = await import(pathToFileURL(join(adapterDir, "mcp-output-guard.ts")).href)
		expect(resolveMcpOutputGuardOptions({}).maxBytes).toBe(12 * 1024)
	})
})
