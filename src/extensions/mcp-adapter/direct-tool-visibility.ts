import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { type ToolVisibilityAPI, createToolVisibility } from "../prompt-construction/tool-visibility.js"

export interface DirectToolVisibilityController {
	markPermanent(names: readonly string[], dynamicToolNames?: Set<string>): void
	expose(names: readonly string[], opts: { markDynamic: boolean; dynamicToolNames?: Set<string> }): void
	hideDynamic(dynamicToolNames: Set<string>): void
}

export function createDirectToolVisibility(pi: ExtensionAPI): DirectToolVisibilityController {
	const visibility = createToolVisibility(pi)
	const permanentToolNames = new Set<string>()

	return {
		markPermanent(names, dynamicToolNames) {
			markPermanent(names, permanentToolNames, dynamicToolNames)
			visibility.enable(names)
		},
		expose(names, opts) {
			if (names.length === 0) return
			visibility.enable(names)
			if (opts.markDynamic) {
				for (const name of names) {
					if (!permanentToolNames.has(name)) opts.dynamicToolNames?.add(name)
				}
				return
			}
			markPermanent(names, permanentToolNames, opts.dynamicToolNames)
		},
		hideDynamic(dynamicToolNames) {
			if (dynamicToolNames.size === 0) return
			visibility.disable([...dynamicToolNames])
			dynamicToolNames.clear()
		},
	}
}

function markPermanent(
	names: readonly string[],
	permanentToolNames: Set<string>,
	dynamicToolNames: Set<string> | undefined,
): void {
	for (const name of names) {
		permanentToolNames.add(name)
		dynamicToolNames?.delete(name)
	}
}
