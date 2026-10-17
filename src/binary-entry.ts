// Dispatch the compiled recovery process before normal startup touches stdio,
// validates auxiliary files, or checks for updates.

// Embed codemode's QuickJS wasm in the compiled executable, the same way pi's own
// bun entry does in dist/bun/runtime-setup.js. Without this, getQuickJSWasmPath()
// falls back to require.resolve from inside the executable and codemode dies with
// "Cannot find module 'quickjs-wasi/quickjs.wasm'".
// The path is read back and registered in entry.ts once pi-mono's config module
// has loaded with PI_PACKAGE_DIR already set.
// This file is only compiled into the binary; the `with { type: "file" }` loader
// attribute is a Bun build feature, not valid for Node-run sources.
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" }

// Same mechanism for pi's codemode worker: pi's bun-binary runtime resolves the
// worker as "./src/extensions/codemode/worker.ts" (pi's own build embeds that
// entrypoint), but kimchi bundles pi's dist and the published package ships no
// src tree — without this, every codemode call in the compiled binary dies with
// "Cannot find module './src/extensions/codemode/worker.ts'". The bundled
// self-contained worker is generated into src/generated/ by build-binary.js.
import codemodeWorkerPath from "./generated/codemode-worker.js" with { type: "file" }

process.env.KIMCHI_QUICKJS_WASM_PATH = quickjsWasmPath
process.env.KIMCHI_CODEMODE_WORKER_PATH = codemodeWorkerPath

await import("./entry.js")
