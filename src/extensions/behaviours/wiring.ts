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
import { markHarnessSteer } from "../steer-marker.js"
import { TriggerEngine } from "./engine.js"
import { EvalEngine } from "./eval-engine.js"
import { registerRulesBlock } from "./rules-block.js"
import { type ResolverIO, resolveSessionContext, type SessionContext } from "./session-context.js"
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

export const BEHAVIOUR_BODY_TYPE = "behaviour"

interface BehaviourBodyDetails {
	name: string
	/** Why this body was steered — absent on first delivery, "compaction" on re-steer. */
	reason?: string
}

export interface WireOptions {
	/** Inject a stub IO for tests; falls back to the live filesystem/git probes. */
	resolverIO?: ResolverIO
}

function collectSessionSpecs(triggered: readonly TriggeredBehaviour[]): ProbeSpec[] {
	const specs: ProbeSpec[] = []
	for (const b of triggered) {
		const { session, gate } = b.triggers
		if (session) specs.push(session.__spec)
		// Gate-declared probes must reach the resolver too: a probe used only
		// as a gate (e.g. not(lspServes("py"))) never runs on the session load
		// path, so without harvesting its spec the resolver leaves
		// ctx.lspServes empty and the gate silently never applies.
		if (gate) specs.push(gate.__spec)
	}
	return specs
}

function isTriggered(b: Behaviour): b is TriggeredBehaviour {
	return b.kind === "triggered"
}

/** A session-branch entry that carries a steered behaviour body. */
function isBehaviourSteerEntry(entry: unknown): entry is { details: { name: string } } {
	if (!entry || typeof entry !== "object") return false
	const record = entry as { type?: unknown; customType?: unknown; details?: unknown }
	if (record.type !== "custom_message" || record.customType !== BEHAVIOUR_BODY_TYPE) return false
	return typeof (record.details as { name?: unknown } | undefined)?.name === "string"
}

/** Names of behaviours whose steer entry is still in the post-compaction
 *  context — i.e. inside the keep-recent window the rewrite retained
 *  verbatim. Undefined when the compaction entry or the session branch
 *  cannot be read (synthetic events, exotic session managers): callers fall
 *  back to re-steering, preserving the delivery guarantee over the dedup. */
function survivingSteerNames(
	event: { compactionEntry?: { id?: string; firstKeptEntryId?: string } },
	ctx?: { sessionManager?: { getBranch?: () => unknown[] } },
): Set<string> | undefined {
	const compaction = event?.compactionEntry
	const branch = ctx?.sessionManager?.getBranch?.()
	if (!compaction || !Array.isArray(branch)) return undefined
	const cutId = compaction.firstKeptEntryId ?? compaction.id
	const cutIndex = branch.findIndex((entry) => (entry as { id?: string }).id === cutId)
	if (cutIndex < 0) return undefined
	const names = new Set<string>()
	for (const entry of branch.slice(cutIndex)) {
		if (isBehaviourSteerEntry(entry)) names.add(entry.details.name)
	}
	return names
}

export function wireBehaviours(pi: ExtensionAPI, behaviours: readonly Behaviour[], options: WireOptions = {}): void {
	const triggered = behaviours.filter(isTriggered)
	const sessionSpecs = collectSessionSpecs(triggered)
	const engine = new TriggerEngine(behaviours)
	const evalEngine = new EvalEngine(behaviours, (name) => engine.isLoaded(name))
	let summaryEmitted = false
	let currentTurnIndex = 0
	// Session-start snapshot passed to evaluateToolTriggers for gate checks.
	// Cleared on session_shutdown — a tool event between shutdown and the
	// next session_start fails open rather than reusing a stale snapshot.
	let currentSessionCtx: SessionContext | undefined

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Reset per-session state so re-fired session_start events (reload, new,
		// fork, resume) don't carry stale loads forward into a fresh session.
		engine.reset()
		evalEngine.reset()
		summaryEmitted = false
		currentTurnIndex = 0
		const sessionContext = resolveSessionContext(sessionSpecs, ctx.cwd, options.resolverIO)
		currentSessionCtx = sessionContext
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

		const loadEvents = engine.evaluateToolTriggers(callEvent, currentTurnIndex, currentSessionCtx)
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
					content: markHarnessSteer(b.body),
					display: false,
					details: { name: b.name } satisfies BehaviourBodyDetails,
				},
				{ deliverAs: "steer" },
			)
		}
	})

	// Re-steer tool-triggered bodies after every successful compaction — but
	// only the ones the rewrite actually dropped. Compaction retains a recent
	// window verbatim (pi 1.3: ~20k keep-recent tokens): a steer inside it
	// survives the rewrite, and re-steering it would duplicate the body in
	// every subsequent request until the next compaction. The event fires
	// after the compaction entry is committed and carries it
	// (firstKeptEntryId), so the post-rewrite branch tells us exactly which
	// steers are still in context; steers outside the kept region were folded
	// into the summary and must be re-steered to stay actionable. A default
	// tool-triggered body never renders a system-prompt block (steer-only
	// delivery), so without this handler the guidance would be lost at the
	// first compaction boundary. Session-triggered bodies never re-steer —
	// their block sits in the system prompt from turn 0 and survives
	// compaction by construction. Standing tool-loaded bodies re-steer under
	// the same rule: their block only enters the prompt at the next
	// user-prompt rebuild, so until then the steer is the only carrier — an
	// inline overflow compaction can consume the original steer, and if the
	// session ends before the next user prompt the block would never render.
	// No pending-queue gating: this fires on every compaction event, bounded
	// at one body per tool-loaded behaviour per compaction. The reason detail
	// distinguishes re-steers from first deliveries without a new entry type.
	pi.on("session_compact", async (event, ctx) => {
		const keptNames = survivingSteerNames(event, ctx)
		for (const b of triggered) {
			if (engine.loadRecord(b.name)?.trigger !== "tool") continue
			if (keptNames?.has(b.name)) continue
			pi.sendMessage(
				{
					customType: BEHAVIOUR_BODY_TYPE,
					content: markHarnessSteer(b.body),
					display: false,
					details: { name: b.name, reason: "compaction" } satisfies BehaviourBodyDetails,
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
		currentSessionCtx = undefined
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

	// Register system-prompt blocks for baseline rules (constant) and each
	// loaded triggered behaviour (dynamic). Dynamic block render is source- and
	// flag-aware: session-triggered bodies render their block from turn 0
	// (cache-stable by construction), and `standing` bodies render on every
	// load path (explicit opt-in that accepts the one-time full-context cache
	// invalidation of a late-rendering block in exchange for front-of-prompt
	// authority). Default tool-triggered bodies are steer-delivered only, so
	// their render returns undefined: a block that renders at the next
	// user-prompt rebuild would rewrite the system prompt mid-session, which is
	// exactly the invalidation steer + re-steer delivery exists to avoid. This
	// is what makes triggered bodies appear in the developer role (system
	// prompt) instead of as user-role messages — the model treats them as
	// standing guidance rather than fresh input to acknowledge. Persistence
	// across turns is automatic for block-rendering bodies: the loaded set
	// survives reset only on a new session_start, and the same set survives
	// compaction by definition; steer-delivered bodies persist via the
	// session_compact re-steer handler above.
	registerRulesBlock(pi, behaviours)
	const blocks = createSystemPromptBlocks(pi, "behaviours")
	for (const b of triggered) {
		blocks.register({
			id: `triggered:${b.name}`,
			render: () => {
				const record = engine.loadRecord(b.name)
				if (!record) return undefined
				if (record.trigger === "session" || b.standing) return b.body
				return undefined
			},
		})
	}
}
