// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { TOOL_RESOURCE_IDS } from "./definitions.js"
import { isResourceEnabled } from "./store.js"

export default function resourceToolBlockerExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		const resourceId = TOOL_RESOURCE_IDS[event.toolName]
		if (!resourceId || isResourceEnabled(resourceId)) return
		return {
			block: true,
			reason: `${event.toolName} is disabled in Kimchi resources. Enable ${resourceId} from /resources.`,
		}
	})
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
