/**
 * Bundled-behaviours extension.
 *
 * Two delivery paths:
 * - **Baseline** behaviours are concatenated into a `## Rules` block appended
 *   to the system prompt at every turn. Always in effect, no per-call cost.
 * - **Triggered** behaviours load when their session-probe triggers fire at
 *   session start, or when their tool-call matchers fire on a tool_call event.
 *   Loaded bodies are delivered as hidden custom messages on the next agent
 *   turn, once per behaviour per session, plus once more after each
 *   compaction (which summarises the body away).
 *
 * On each tool-call event the eval engine runs first against the prior loaded
 * set, then the trigger engine evaluates tool-call triggers; this ensures the
 * call that loads a behaviour is not also scored against its own evaluators.
 *
 * Triggered loads, eval verdicts, and a per-session summary are written into
 * the active session JSONL (`behaviour_loaded`, `behaviour_eval`,
 * `behaviour_session_summary`) so decisions can be audited offline.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { TriggerEngine } from "./engine.js"
import { EvalEngine } from "./eval-engine.js"
import { behaviours } from "./registry.js"
import { resolveSessionContext } from "./session-context.js"
import {
	BEHAVIOUR_EVAL_TYPE,
	BEHAVIOUR_LOADED_TYPE,
	BEHAVIOUR_SESSION_SUMMARY_TYPE,
	type BehaviourEvalData,
	type BehaviourLoadedData,
	type BehaviourSessionSummaryData,
	type BehaviourSummaryEntry,
} from "./stats.js"
import type { ProbeSpec } from "./triggers.js"
import type { Behaviour, TriggerSource } from "./types.js"

const RULES_HEADER = "## Rules"
export const BEHAVIOUR_BODY_TYPE = "behaviour_body"

interface BehaviourBodyDetails {
	name: string
}

interface LoadRecord {
	loadedAtTurn: number
	trigger: TriggerSource
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
	const evalEngine = new EvalEngine(behaviours, (name) => engine.isLoaded(name))
	const loadRecords = new Map<string, LoadRecord>()
	let summaryEmitted = false
	let currentTurnIndex = 0

	function recordLoads(events: { name: string; trigger: TriggerSource; turnIndex: number }[]): void {
		for (const e of events) {
			if (loadRecords.has(e.name)) continue
			loadRecords.set(e.name, { loadedAtTurn: e.turnIndex, trigger: e.trigger })
		}
	}

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Reset per-session state so re-fired session_start events (reload, new,
		// fork, resume) don't carry stale loads forward into a fresh session.
		engine.reset()
		evalEngine.reset()
		loadRecords.clear()
		summaryEmitted = false
		currentTurnIndex = 0
		const sessionContext = resolveSessionContext(sessionSpecs, ctx.cwd)
		const events = engine.evaluateSessionTriggers(sessionContext, currentTurnIndex)
		recordLoads(events)
		for (const e of events) {
			pi.appendEntry<BehaviourLoadedData>(BEHAVIOUR_LOADED_TYPE, {
				name: e.name,
				trigger: e.trigger,
				turnIndex: e.turnIndex,
			})
		}
	})

	pi.on("turn_start", async (event) => {
		currentTurnIndex = event.turnIndex
	})

	pi.on("tool_call", async (event) => {
		const callEvent = { toolName: event.toolName, input: event.input as Record<string, unknown> }

		// Score evals against the prior loaded set first, so a behaviour loaded
		// by this same tool-call does not get scored on the call that loaded it.
		const evalEvents = evalEngine.evaluate(callEvent, currentTurnIndex)
		for (const e of evalEvents) {
			pi.appendEntry<BehaviourEvalData>(BEHAVIOUR_EVAL_TYPE, {
				name: e.name,
				verdict: e.verdict,
				turnIndex: e.turnIndex,
				toolName: e.toolName,
				toolArgs: e.toolArgs,
			})
		}

		const loadEvents = engine.evaluateToolTriggers(callEvent, currentTurnIndex)
		recordLoads(loadEvents)
		for (const e of loadEvents) {
			pi.appendEntry<BehaviourLoadedData>(BEHAVIOUR_LOADED_TYPE, {
				name: e.name,
				trigger: e.trigger,
				turnIndex: e.turnIndex,
				toolArgs: e.toolArgs,
			})
		}
	})

	// After compaction, the summarisation step replaces the conversation window
	// (including any prior behaviour bodies) with a synthesised summary. Re-queue
	// every loaded behaviour for re-injection on the next agent turn. The loaded
	// set is preserved — triggers do not re-fire, no duplicate `behaviour_loaded`
	// entries are emitted.
	pi.on("session_compact", async () => {
		engine.requeueLoaded()
	})

	pi.on("session_shutdown", async () => {
		if (summaryEmitted) return
		summaryEmitted = true
		const entries: BehaviourSummaryEntry[] = behaviours.map((b) => {
			const counters = evalEngine.countersFor(b.name)
			const record = loadRecords.get(b.name)
			const entry: BehaviourSummaryEntry = {
				name: b.name,
				loaded: record !== undefined || b.kind === "baseline",
				observed: counters.observed,
				violated: counters.violated,
			}
			if (record) {
				entry.loadedAtTurn = record.loadedAtTurn
				entry.trigger = record.trigger
			}
			return entry
		})
		pi.appendEntry<BehaviourSessionSummaryData>(BEHAVIOUR_SESSION_SUMMARY_TYPE, { behaviours: entries })
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
