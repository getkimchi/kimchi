import { createCodemodeExtension, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { isDefaultToolEnabled } from "../../settings-watcher.js"
import { createCodemodeOutcomeTracker } from "./outcome.js"
import { CODEMODE_PURPOSE_MAX_CHARS } from "./purpose.js"

/** Selection rule shown at the moment of tool choice. Codemode pays off when
 *  intermediate output can be filtered before it reaches the model, or when
 *  later arguments follow mechanically from earlier results; independent calls
 *  whose full results are needed already cost one round as direct parallel calls.
 *  The grep line format (pi's grep tool) is what a chaining script must parse. */
export const CODEMODE_SELECTION_GUIDANCE = `Use to filter large results before they reach you, or to chain calls whose arguments depend on earlier results. For independent calls whose full results you need, call tools directly in one turn. Nested grep output uses \`path:line: text\`.

Start every script with a purpose line: \`// @description: <short purpose>\` (one line, maximum ${CODEMODE_PURPOSE_MAX_CHARS} characters). Source order: \`@options\` when used → \`// @description: <short purpose>\` → executable code.`

/** Decorate Pi's dynamic tool description without replacing its execution or loadout logic. */
export function createGuidedCodemodeExtension(): ExtensionFactory {
	const upstream = createCodemodeExtension()
	return (pi) => {
		const outcomes = createCodemodeOutcomeTracker()
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
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					outcomes.begin(ctx, toolCallId)
					let completed = false
					try {
						const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx)
						const contextReduction = outcomes.complete(ctx, toolCallId, result)
						completed = true
						// No details object: nothing to attach to, so the renderer shows no estimate.
						if (!result.details || typeof result.details !== "object") return result
						return { ...result, details: { ...result.details, contextReduction } }
					} finally {
						if (!completed) outcomes.discard(ctx, toolCallId)
					}
				},
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
		pi.on("tool_execution_start", (event, ctx) => outcomes.nestedStart(ctx, event))
		pi.on("tool_execution_end", (event, ctx) => outcomes.nestedEnd(ctx, event))
		pi.on("agent_end", (_event, ctx) => outcomes.discard(ctx))
		pi.on("session_shutdown", (_event, ctx) => outcomes.discard(ctx))
	}
}
