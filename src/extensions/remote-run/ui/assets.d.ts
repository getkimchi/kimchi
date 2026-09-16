// Ambient declaration for inlined browser-viewer CSS/JS bundles. Bun's
// bundler embeds `import asset from "./x.css" with { type: "text" }` as a
// string constant (same pattern as behaviours/bodies.d.ts); the shim lets
// tsc resolve the import in editors/typecheck.
declare module "*.css" {
	const content: string
	export default content
}

declare module "*.min.js" {
	const content: string
	export default content
}
