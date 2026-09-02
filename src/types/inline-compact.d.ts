import type { CompactionResult } from "@earendil-works/pi-coding-agent"
import type { InlineCompactOptions } from "../upstream-inline-compact-patch.js"

declare module "@earendil-works/pi-coding-agent" {
	interface ExtensionContext {
		inlineCompact?: (options?: InlineCompactOptions) => Promise<CompactionResult>
	}
}
