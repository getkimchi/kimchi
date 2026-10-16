// Bun build-time file import: under `--compile` the asset embeds in the
// executable and the default export is a readable path inside $bunfs.
declare module "quickjs-wasi/quickjs.wasm" {
	const quickjsWasmPath: string
	export default quickjsWasmPath
}
