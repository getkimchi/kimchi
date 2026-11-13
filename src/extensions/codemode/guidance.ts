import { createCodemodeExtension, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent"

/** Selection rule shown at the moment of tool choice. Codemode pays off when
 *  intermediate output can be filtered before it reaches the model, or when
 *  later arguments follow mechanically from earlier results; independent calls
 *  whose full results are needed already cost one round as direct parallel calls.
 *  The grep line format (pi's grep tool) is what a chaining script must parse. */
export const CODEMODE_SELECTION_GUIDANCE =
	"Use to filter large output before it reaches the model, or to chain calls whose arguments follow mechanically from earlier results. For independent calls whose full results you need, call tools directly in one turn. Nested grep resolves to `path:line: text` lines."

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
						descriptions: {
							...changes.descriptions,
							codemode: `${CODEMODE_SELECTION_GUIDANCE}\n\n${description}`,
						},
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
