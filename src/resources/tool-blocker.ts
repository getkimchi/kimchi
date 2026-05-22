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
