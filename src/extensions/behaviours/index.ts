/**
 * Bundled-behaviours extension.
 *
 * Two delivery paths:
 * - **Baseline** behaviours are concatenated into a `## Rules` block appended
 *   to the system prompt at every turn. Always in effect, no per-call cost.
 * - **Triggered** behaviours load when their session-probe triggers fire at
 *   session start. Loaded bodies are delivered as hidden custom messages on
 *   the next agent turn, once per behaviour per session.
 *
 * Triggered loads are written into the active session JSONL as
 * `behaviour_loaded` custom entries so the load decisions can be audited
 * offline.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { TriggerEngine } from "./engine.js"
import { behaviours } from "./registry.js"
import { resolveSessionContext } from "./session-context.js"
import { BEHAVIOUR_LOADED_TYPE, type BehaviourLoadedData } from "./stats.js"
import type { ProbeSpec } from "./triggers.js"
import type { Behaviour } from "./types.js"

const RULES_HEADER = "## Rules"
export const BEHAVIOUR_BODY_TYPE = "behaviour_body"

interface BehaviourBodyDetails {
	name: string
}

function buildRulesBlock(all: readonly Behaviour[]): string {
	const baseline = all.filter((b) => b.kind === "baseline").map((b) => b.body.trim())
	if (baseline.length === 0) return ""
	return `\n\n${RULES_HEADER}\n\n${baseline.join("\n\n")}\n`
}

function collectSessionSpecs(triggered: readonly Behaviour[]): ProbeSpec[] {
	const specs: ProbeSpec[] = []
	for (const b of triggered) {
		const probe = b.triggers?.session
		if (probe) specs.push(probe.__spec)
	}
	return specs
}

export default function behavioursExtension(pi: ExtensionAPI): void {
	const rulesBlock = buildRulesBlock(behaviours)
	const triggered = behaviours.filter((b) => b.kind === "triggered")
	const sessionSpecs = collectSessionSpecs(triggered)
	const engine = new TriggerEngine(behaviours)

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Reset per-session state so re-fired session_start events (reload, new,
		// fork, resume) don't carry stale loads forward into a fresh session.
		engine.reset()
		const sessionContext = resolveSessionContext(sessionSpecs, ctx.cwd)
		const events = engine.evaluateSessionTriggers(sessionContext, 0)
		for (const e of events) {
			pi.appendEntry<BehaviourLoadedData>(BEHAVIOUR_LOADED_TYPE, {
				name: e.name,
				trigger: e.trigger,
				turnIndex: e.turnIndex,
			})
		}
	})

	if (rulesBlock) {
		pi.on("before_agent_start", async (event) => {
			return { systemPrompt: event.systemPrompt + rulesBlock }
		})
	}

	// One injector handler per triggered behaviour. The runner aggregates
	// messages across all `before_agent_start` handlers, so multiple pending
	// bodies are delivered together on the next turn. Each handler closes over
	// its behaviour and emits the body iff the engine still has it pending.
	for (const b of triggered) {
		pi.on("before_agent_start", async () => {
			if (!engine.takePending(b.name)) return
			return {
				message: {
					customType: BEHAVIOUR_BODY_TYPE,
					content: b.body,
					display: false,
					details: { name: b.name } satisfies BehaviourBodyDetails,
				},
			}
		})
	}
}
