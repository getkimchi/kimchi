// Dispatch the compiled recovery process before normal startup touches stdio,
// validates auxiliary files, or checks for updates.
//
// No top-level await: `bun build --compile --bytecode` (and --minify) reject
// TLA anywhere in the bundled graph, so startup is structured as an explicit
// async main instead.
import { MCP_KEYRING_HELPER_COMMAND } from "./extensions/mcp/keyring-recovery.js"

async function main(): Promise<void> {
	if (process.argv.length === 3 && process.argv[2] === MCP_KEYRING_HELPER_COMMAND) {
		const { installKeyringRequireBridge } = await import("./extensions/mcp/keyring-require-bridge.js")
		installKeyringRequireBridge()
		// The pinned adapter does not export this subpath. A literal require bundles
		// its existing protocol implementation; the bridge resolves its native addon.
		require("../node_modules/pi-mcp-adapter/mcp-keyring-helper.cjs")
	} else {
		await import("./entry.js")
	}
}

void main()
