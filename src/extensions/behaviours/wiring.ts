/**
 * Pure wiring layer — connects a behaviour registry to an `ExtensionAPI`.
 * Lives in its own module so vitest can import it without resolving the Bun
 * text imports under `bodies/` (which `registry.ts` pulls in). Mirrors the
 * `build.ts` / `registry.ts` split.
 *
 * The default-export extension in `index.ts` calls `wireBehaviours` with the
 * bundled registry; tests pass synthetic behaviours and a stub IO to exercise
 * the same handlers without filesystem/process dependencies.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { TriggerEngine } from "./engine.js"
import { EvalEngine } from "./eval-engine.js"
import { type ResolverIO, resolveSessionContext } from "./session-context.js"
import {
	BEHAVIOUR_EVAL_TYPE,
	BEHAVIOUR_LOADED_TYPE,
	BEHAVIOUR_REQUEUED_TYPE,
	BEHAVIOUR_SESSION_SUMMARY_TYPE,
	type BehaviourEvalData,
	type BehaviourLoadedData,
	type BehaviourRequeuedData,
	type BehaviourSessionSummaryData,
	type BehaviourSummaryEntry,
} from "./stats.js"
import type { ProbeSpec } from "./triggers.js"
import type { Behaviour, TriggeredBehaviour } from "./types.js"

const RULES_HEADER = "## Rules"
export const BEHAVIOUR_BODY_TYPE = "behaviour"

interface BehaviourBodyDetails {
	name: string
}

export interface WireOptions {
	/** Inject a stub IO for tests; falls back to the live filesystem/git probes. */
	resolverIO?: ResolverIO
}

function buildRulesBlock(all: readonly Behaviour[]): string {
	const baseline = all.filter((b) => b.kind === "baseline").map((b) => b.body.trim())
	if (baseline.length === 0) return ""
	return `\n\n${RULES_HEADER}\n\n${baseline.join("\n\n")}\n`
}

function collectSessionSpecs(triggered: readonly TriggeredBehaviour[]): ProbeSpec[] {
	const specs: ProbeSpec[] = []
	for (const b of triggered) {
		const probe = b.triggers.session
		if (probe) specs.push(probe.__spec)
	}
	return specs
}

function isTriggered(b: Behaviour): b is TriggeredBehaviour {
	return b.kind === "triggered"
}

export function wireBehaviours(pi: ExtensionAPI, behaviours: readonly Behaviour[], options: WireOptions = {}): void {
	const rulesBlock = buildRulesBlock(behaviours)
	const triggered = behaviours.filter(isTriggered)
	const sessionSpecs = collectSessionSpecs(triggered)
	const engine = new TriggerEngine(behaviours)
	const evalEngine = new EvalEngine(behaviours, (name) => engine.isLoaded(name))
	let summaryEmitted = false
	let currentTurnIndex = 0

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Reset per-session state so re-fired session_start events (reload, new,
		// fork, resume) don't carry stale loads forward into a fresh session.
		engine.reset()
		evalEngine.reset()
		summaryEmitted = false
		currentTurnIndex = 0
		const sessionContext = resolveSessionContext(sessionSpecs, ctx.cwd, options.resolverIO)
		const events = engine.evaluateSessionTriggers(sessionContext, currentTurnIndex)
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
		for (const e of loadEvents) {
			pi.appendEntry<BehaviourLoadedData>(BEHAVIOUR_LOADED_TYPE, {
				name: e.name,
				trigger: e.trigger,
				turnIndex: e.turnIndex,
				toolArgs: e.toolArgs,
			})
		}
	})

	// Drain any pending bodies as steer messages right after the tool result so
	// the model sees them before its next inference within the same turn.
	// `before_agent_start` only fires per user prompt, so without this hook a
	// behaviour that loads on a tool_call mid-turn would never reach the model
	// in that session.
	pi.on("tool_result", async () => {
		for (const b of triggered) {
			if (!engine.takePending(b.name)) continue
			pi.sendMessage(
				{
					customType: BEHAVIOUR_BODY_TYPE,
					content: b.body,
					display: false,
					details: { name: b.name } satisfies BehaviourBodyDetails,
				},
				{ deliverAs: "steer" },
			)
		}
	})

	// After compaction, the summarisation step replaces the conversation window
	// (including any prior behaviour bodies) with a synthesised summary. Re-queue
	// every loaded behaviour for re-injection on the next agent turn. The loaded
	// set is preserved — triggers do not re-fire, no duplicate `behaviour_loaded`
	// entries are emitted; instead a `behaviour_requeued` row signals the
	// re-injection so offline analysis can distinguish first load from re-deliver.
	pi.on("session_compact", async () => {
		const requeued = engine.requeueLoaded()
		for (const name of requeued) {
			pi.appendEntry<BehaviourRequeuedData>(BEHAVIOUR_REQUEUED_TYPE, { name, turnIndex: currentTurnIndex })
		}
	})

	// Summary fires on graceful shutdown only — a hard crash (kill -9, OOM,
	// power loss) skips this handler and the session ends without a summary
	// row. Loaded/eval rows are durable (appended live), so offline analysis
	// can still reconstruct totals from them; only the rolled-up snapshot is
	// lost.
	pi.on("session_shutdown", async () => {
		if (summaryEmitted) return
		summaryEmitted = true
		const entries: BehaviourSummaryEntry[] = []
		for (const b of behaviours) {
			const record = engine.loadRecord(b.name)
			const isBaseline = b.kind === "baseline"
			if (!isBaseline && !record) continue
			const counters = evalEngine.countersFor(b.name)
			const entry: BehaviourSummaryEntry = {
				name: b.name,
				loaded: isBaseline || record !== undefined,
				observed: counters.observed,
				violated: counters.violated,
			}
			if (record) {
				entry.loadedAtTurn = record.turnIndex
				entry.trigger = record.trigger
			}
			entries.push(entry)
		}
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
