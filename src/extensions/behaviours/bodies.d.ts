// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
// Ambient declaration for bundled behaviour markdown bodies. Bun's bundler
// inlines `import body from "./foo.md" with { type: "text" }` as a string
// constant; this shim lets tsc resolve the same import during typecheck.
declare module "*.md" {
	const content: string
	export default content
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
