import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode"
import quickJSWasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" }
import { getCodemodeWorkerSpecifier } from "../node_modules/@earendil-works/pi-coding-agent/dist/config.js"

const workerUrl = getCodemodeWorkerSpecifier()
let workerExited: Promise<void> | undefined
const sandbox = new CodemodeSandbox({
	workerUrl,
	wasm: loadQuickJSWasm(quickJSWasmPath),
	timeoutMs: 20_000,
	onWorkerStarted(exited) {
		workerExited = exited
	},
})
try {
	const result = await sandbox.execute("return 21 * 2", { signal: AbortSignal.timeout(20_000) })
	console.log(JSON.stringify({ workerUrl, result }))
} finally {
	await sandbox.close()
	await workerExited
}
