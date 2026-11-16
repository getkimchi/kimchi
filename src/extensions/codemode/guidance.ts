import { createCodemodeExtension, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { isDefaultToolEnabled } from "../../settings-watcher.js"

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
			pi.registerTool({
				...tool,
				// Kimchi owns codemode's default exposure. Pi registers the tool
				// inactive, so activation used to ride on ferment's idle-profile
				// snapshot (its before_agent_start applies it in every
				// non-worker session); with the ferment resource disabled no
				// profile was ever applied and codemode — plus the Tool
				// Selection rule conditioned on it — silently vanished. Activate
				// at registration instead.
				defaultActive: true,
				prepareLoadout(loadout) {
					// Called on the original definition so pi's receiver is preserved.
					const changes = tool.prepareLoadout?.(loadout)
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
		// Pi force-activates extension-registered tools past the defaultTools
		// filter (see settings-watcher.ts), so `-codemode` is enforced here
		// instead. This mirrors the filter ferment's idle snapshot already
		// applies, so a defaultTools list that does not name codemode keeps the
		// tool off exactly as before — now on every surface, ferment or not.
		// Runs after settingsTrustSyncExtension (first in the shared list) has
		// recorded the session's cwd/trust for isDefaultToolEnabled.
		pi.on("session_start", async () => {
			if (isDefaultToolEnabled("codemode")) return
			const active = pi.getActiveTools()
			if (!active.includes("codemode")) return
			pi.setActiveTools(active.filter((name) => name !== "codemode"))
		})
	}
}
