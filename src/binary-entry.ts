// Dispatch the compiled recovery process before normal startup touches stdio,
// validates auxiliary files, or checks for updates.
//
// No top-level await: `bun build --compile --bytecode` (and --minify) reject
// TLA anywhere in the bundled graph, so startup is structured as an explicit
// async main instead.

// Embed codemode's QuickJS wasm in the compiled executable, the same way pi's own
// bun entry does in dist/bun/runtime-setup.js. Without this, getQuickJSWasmPath()
// falls back to require.resolve from inside the executable and codemode dies with
// "Cannot find module 'quickjs-wasi/quickjs.wasm'".
// The path is read back and registered in entry.ts once pi-mono's config module
// has loaded with PI_PACKAGE_DIR already set.
// This file is only compiled into the binary; the `with { type: "file" }` loader
// attribute is a Bun build feature, not valid for Node-run sources.
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" }
import { MCP_KEYRING_HELPER_COMMAND } from "./extensions/mcp/keyring-recovery.js"

process.env.KIMCHI_QUICKJS_WASM_PATH = quickjsWasmPath

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
