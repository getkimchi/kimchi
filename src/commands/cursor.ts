// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import "../integrations/cursor.js" // side-effect: register integration
import { byId } from "../integrations/registry.js"
import { popScope, prepareTool } from "./_helpers.js"

export async function runCursor(args: string[]): Promise<number> {
	const scope = popScope(args)
	const prepped = await prepareTool("cursor", "override")
	if (!prepped) return 1

	try {
		const tool = byId("cursor")
		if (!tool) {
			console.error("kimchi cursor: integration not registered")
			return 1
		}
		await tool.write(scope, prepped.apiKey, prepped.models)
		console.log("kimchi cursor: configuration written. Restart Cursor to pick up the kimchi provider.")
		return 0
	} catch (err) {
		console.error(`kimchi cursor: ${(err as Error).message}`)
		return 1
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
