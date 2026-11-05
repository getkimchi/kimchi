import { createCodemodeExtension, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent"

export const CODEMODE_SELECTION_GUIDANCE =
	"Use codemode when a later tool's arguments can be derived mechanically from an earlier result: search for a symbol, select matching paths, read relevant ranges, and return concise findings in one call. Use direct tools when you need to interpret a result before choosing the next step or need full file contents."

/** Decorate Pi's dynamic tool description without replacing its execution or loadout logic. */
export function createGuidedCodemodeExtension(): ExtensionFactory {
	const upstream = createCodemodeExtension()
	return (pi) => {
		const registerTool: ExtensionAPI["registerTool"] = (tool) => {
			if (tool.name !== "codemode") return pi.registerTool(tool)
			const prepareLoadout = tool.prepareLoadout
			pi.registerTool({
				...tool,
				prepareLoadout(loadout) {
					const changes = prepareLoadout?.(loadout)
					const description = changes?.descriptions?.codemode
					if (!description) return changes
					return {
						...changes,
						descriptions: { ...changes.descriptions, codemode: `${CODEMODE_SELECTION_GUIDANCE}\n\n${description}` },
					}
				},
			})
		}
		upstream(
			new Proxy(pi, {
				get(target, property, receiver) {
					return property === "registerTool" ? registerTool : Reflect.get(target, property, receiver)
				},
			}),
		)
	}
}
