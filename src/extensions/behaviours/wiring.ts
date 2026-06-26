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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { deferExtensionAction } from "../deferred-action.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { TriggerEngine } from "./engine.js"
import { EvalEngine } from "./eval-engine.js"
import { type ResolverIO, resolveSessionContext } from "./session-context.js"
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
	return `${RULES_HEADER}\n\n${baseline.join("\n\n")}`
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
		if (events.length > 0) {
			deferExtensionAction(() => {
				for (const e of events) {
					pi.appendEntry<BehaviourLoadedData>(BEHAVIOUR_LOADED_TYPE, {
						name: e.name,
						trigger: e.trigger,
						turnIndex: e.turnIndex,
					})
				}
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

	// Drain tool-triggered bodies as steer messages right after the tool result
	// so the model sees them before its next inference within the same turn.
	// The system prompt is rebuilt only per user prompt, so without this hook
	// a behaviour that loads on a tool_call mid-turn would only reach the model
	// on the next user turn. The pending queue ensures each tool-triggered body
	// is steered exactly once. Session-triggered bodies never go through this
	// path — they appear in the system prompt via the registered block below.
	pi.on("tool_result", async () => {
		for (const b of triggered) {
			if (engine.loadRecord(b.name)?.trigger !== "tool") continue
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

	// Register system-prompt blocks for baseline rules and each loaded
	// triggered behaviour. Block render returns the body iff the engine has
	// the behaviour loaded; otherwise undefined makes the block skip silently.
	// This is what makes triggered bodies appear in the developer role
	// (system prompt) instead of as user-role messages — the model treats them
	// as standing guidance rather than fresh input to acknowledge. Persistence
	// across turns is automatic: the loaded set survives reset only on a new
	// session_start, and the same set survives compaction by definition.
	const blocks = createSystemPromptBlocks(pi, "behaviours")
	if (rulesBlock) {
		blocks.register({
			id: "rules",
			render: () => rulesBlock.trim(),
		})
	}
	for (const b of triggered) {
		blocks.register({
			id: `triggered:${b.name}`,
			render: () => (engine.isLoaded(b.name) ? b.body : undefined),
		})
	}
}
