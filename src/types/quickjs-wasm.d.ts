// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
// Bun build-time file import: under `--compile` the asset embeds in the
// executable and the default export is a readable path inside $bunfs.
declare module "quickjs-wasi/quickjs.wasm" {
	const quickjsWasmPath: string
	export default quickjsWasmPath
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
