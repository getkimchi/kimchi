/**
 * Memory extension: persistent personal memory for chat sessions, backed by
 * Mem0 OSS with the SQLite store and remote embeddings (see backend.ts).
 *
 * Injection policy — auto-injected context must earn its tokens:
 *   - The retrieval query is grounded in the session's opening prompt (the
 *     first `before_agent_start`'s `event.prompt`), not a standing query.
 *   - Facts must clear the relevance threshold and the top-N / token caps
 *     (inject.ts). When nothing clears the bar, NO FACTS are injected — an
 *     empty digest is the normal outcome for unrelated sessions; only the
 *     constant enabled-notice section goes out.
 *   - Cache contract: the digest is computed on the first agent start
 *     (turn 1 awaits it) and appended with identical bytes on EVERY start —
 *     the provider-facing prefix is stable from the very first request,
 *     so memory causes zero mid-session cache breaks. It is recomputed
 *     only after a compaction, where the prefix breaks anyway. A session
 *     whose digest came back empty injects only the constant notice — the
 *     model must know capture is automatic (it has no write tool).
 *   - `memory_search` is the pull-based supplement for anything the digest
 *     did not surface.
 *   - In-session management: the `/memory` command (same grammar as the
 *     `kimchi memory` CLI subcommand — admin.ts) lists, searches, deletes,
 *     resets, and flips the session-scoped runtime toggle (enable|disable).
 *     Deletion is user-only; the model never gets a write tool.
 *   - Progressive recall (turns 2+): each new user prompt plus the tail of
 *     the last assistant response (the model may drive the conversation) is
 *     a drift signal; a free lexical-coverage gate decides when a retrieval
 *     is worth an embedding call, and only NEW facts (deduped via the
 *     delivery ledger) deliver as hidden steer messages — conversation-tail
 *     appends, so the prefix stays byte-stable. One shared deduping embedder
 *     serves both stores, so each lookup embeds its query once. Compaction
 *     resets everything: the prefix breaks anyway.
 *
 * Failures degrade to no-memory: store/search errors log once and leave
 * the session untouched. Memory must never break a session.
 *
 *   - Session-scoped toggle: `/memory enable|disable` (or the ACP
 *     `set_memory_enabled` ext-method) flip a per-session runtime switch —
 *     session-toggle.ts is the shared channel. The persistent feature switch
 *     stays the extensions.memory resource (/resources, restart required).
 */
import { randomUUID } from "node:crypto"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { resolveGatewayCredentials } from "../../auth/gateway-credentials.js"
import { MEMORY_SAVED_STATUS_KEY, MEMORY_STATUS_KEY } from "../../components/status-line.js"
import { loadConfig } from "../../config.js"
import { submitTimingMark } from "../submit-timing.js"
import {
	type AdminCommand,
	adminDeleteFacts,
	adminExplainFact,
	adminListFacts,
	adminSearchFacts,
	formatMemoryExplanation,
	memoryCountText,
	parseAdminArgs,
	runAdminCommand,
} from "./admin.js"
import { createMemoryBackend, memoryDbPath } from "./backend.js"
import { messageText, readCaptureSessionSaved, wireMemoryCapture } from "./capture.js"
import {
	DIGEST_SCORE_THRESHOLD,
	loopContextTurns,
	MEMORY_LOOP_RECALL_CHANGED_COOLDOWN_MS,
	MEMORY_LOOP_RECALL_TIMEOUT_MS,
	MEMORY_PRE_REQUEST_TIMEOUT_MS,
	MEMORY_SEARCH_TIMEOUT_MS,
	MEMORY_STEP_ENV_RECEIPT_KEEP_CHARS,
	MEMORY_USER_ID,
	stateFingerprintCap,
	stepRecallInterval,
	TURN_RECALL_QUERY_MAX_CHARS,
	TURN_RECALL_RESPONSE_CHARS,
} from "./config.js"
import { awaitRecallDeadline, RecallDeadline, withRecallDeadline } from "./deadline.js"
import { batchChoice, type DecisionGateOptions, decide, systemoneEndpoint } from "./decision-gate.js"
import {
	type DecisionGateKind,
	digestQuestion,
	digestState,
	parseDecisionGateFlag,
	recallQuestion,
	recallState,
} from "./gates.js"
import {
	buildMemoryDigest,
	type DigestComposition,
	digestCandidateTexts,
	digestSelectionFloor,
	factKey,
	isCovered,
	MEMORY_ENABLED_NOTICE,
	MEMORY_ENABLED_NOTICE_AUTHORED,
	shouldRunDigestSelection,
} from "./inject.js"
import { MemoryPanel, type MemoryPanelFact } from "./memory-panel.js"
import { migrateAgentMemory } from "./migrate-agent-memory.js"
import {
	buildLoopRecallNeed,
	buildLoopRecallQuery,
	type RecallCompletion,
	type RecallOutcome,
	type RecallTrigger,
	runRecall,
	selectedFactIds,
	stateFingerprint,
} from "./recall.js"
import { recallNeedFacets, recallNeedFingerprint, shouldEvaluateRecallNeed } from "./recall-need.js"
import { createScopedSearcher } from "./scoped-searcher.js"
import { getSessionMemoryOverride, setSessionMemoryOverride } from "./session-toggle.js"
import {
	createMemoryTelemetryReporter,
	type MemoryGateStatus,
	type MemoryRecallCompositionTelemetry,
	type MemoryRecallOutcome,
	type MemoryRecallTrigger,
	type MemoryTelemetryReporter,
} from "./telemetry-events.js"
import { authoredEnabled, createMemorySaveTool, createMemorySearchTool } from "./tools.js"
import { createRecallRecorder, type TraceRecorder } from "./trace.js"

/** What one search call returns after the value gate. */
interface DigestState {
	text: string
	/** Fact texts in the digest — seeds the delivery ledger. */
	facts: string[]
	factIds: string[]
	composition: DigestComposition
	query: string
	recallId: string
	generation: number
	recorder: TraceRecorder | null
}

interface DigestComputationTelemetry {
	gateStatus: MemoryGateStatus
	searchCount: number
	noSearcher: boolean
	failed: boolean
	composition?: DigestComposition
}

const RECALL_OUTCOME_MAP: Record<RecallOutcome, MemoryRecallOutcome> = {
	injected: "delivered",
	covered: "covered",
	"gate-skip": "gate_skip",
	"no-hits": "no_hits",
	"no-searcher": "no_searcher",
	failed: "failed",
	cancelled: "cancelled",
	"timed-out": "timed_out",
	droppedStale: "dropped_stale",
}

const RECALL_TRIGGER_MAP: Record<RecallTrigger, MemoryRecallTrigger> = {
	"user-turn": "user_turn",
	"step-budget": "step_budget",
	"step-budget-turnend": "step_budget",
	"state-revisit": "state_revisit",
}

function compositionTelemetry(composition: DigestComposition | undefined): MemoryRecallCompositionTelemetry {
	return {
		consideredCount: composition?.considered ?? 0,
		belowThresholdCount: composition?.belowThreshold ?? 0,
		selectorSkippedCount: composition?.selectorSkipped ?? 0,
		overCapCount: composition?.overCap ?? 0,
		overBudgetCount: composition?.overBudget ?? 0,
		estimatedTokens: composition?.tokensEstimated ?? 0,
	}
}

function reportProgressiveRecallTelemetry(reporter: MemoryTelemetryReporter, completion: RecallCompletion): void {
	reporter({
		event: "recall.completed",
		kind: "digest_progressive",
		trigger: RECALL_TRIGGER_MAP[completion.trigger],
		outcome: RECALL_OUTCOME_MAP[completion.outcome],
		delivery: completion.delivery,
		gateStatus: completion.gateStatus,
		durationMs: completion.durationMs,
		searchCount: completion.searchCount,
		selectedCount: completion.selectedCount,
		deliveredCount: completion.deliveredCount,
		...compositionTelemetry(completion.composition),
	})
}

function reportInitialDigestTelemetry(
	reporter: MemoryTelemetryReporter,
	params: {
		outcome: MemoryRecallOutcome
		delivery: "attached" | "none"
		durationMs: number
		state: DigestState | null | undefined
		details: DigestComputationTelemetry
	},
): void {
	reporter({
		event: "recall.completed",
		kind: "digest_init",
		trigger: "before_agent_start",
		outcome: params.outcome,
		delivery: params.delivery,
		gateStatus: params.details.gateStatus,
		durationMs: params.durationMs,
		searchCount: params.details.searchCount,
		selectedCount: params.state?.facts.length ?? params.details.composition?.facts ?? 0,
		deliveredCount: params.delivery === "attached" ? (params.state?.facts.length ?? 0) : 0,
		...compositionTelemetry(params.details.composition),
	})
}

export interface MemorySearcher {
	/** topK override: the digest selection floor widens its net to floor+1
	 * so the floor can actually be crossed; omit for the store default. */
	search(query: string, topK?: number): Promise<Array<{ id?: string; memory?: string; score?: number }>>
}

export interface MemoryExtensionDeps {
	/** Flag gate — tests force it on without touching process.argv. */
	isEnabled?: () => boolean
	/** Searcher factory — tests inject a stub; default builds the real backend. */
	createSearcher?: () => Promise<MemorySearcher | undefined>
	/** Decision-gate context — tests inject a stub; default resolves from
	 * config + KIMCHI_MEMORY_DECISION_GATE once per runtime. */
	decision?: () => { gate: DecisionGateOptions | null; enabled: ReadonlySet<DecisionGateKind> }
	/** Per-runtime capture session id — attribution for the "· N saved" half
	 *  and the "Last session" line. Default: a fresh uuid per extension
	 *  instance (correct for ACP servers hosting concurrent sessions in one
	 *  process); tests inject a fixed id. */
	captureId?: string
}

/**
 * Race a memory search against a bounded timeout — a hung gateway call must
 * degrade to no-memory instead of stalling the session's first prompt (the
 * SDK's own timeouts are minutes). Rejections pass through unchanged so the
 * existing degrade paths (computeDigest's catch, the recall block's catch)
 * keep their semantics; the timer is unreffed so a pending race can never
 * hold the process open at shutdown.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
	return new Promise<T | null>((resolve, reject) => {
		const timer = setTimeout(() => {
			// Neutral wording — the fallback is call-site-specific: the digest
			// degrades to no-injection, the recall gate falls open to searching.
			console.error(`[memory] ${label} timed out after ${ms}ms`)
			resolve(null)
		}, ms)
		timer.unref()
		promise.then(
			(result) => {
				clearTimeout(timer)
				resolve(result)
			},
			(err) => {
				clearTimeout(timer)
				reject(err)
			},
		)
	})
}

/**
 * The in-session /memory fallback view: a read-only widget above the
 * input for non-panel output (the overview, errors). list|search open the
 * interactive MemoryPanel instead. The TUI caps string widgets at 10
 * lines, so the cap keeps our hint line instead of its
 * "... (widget truncated)". Cleared when an agent turn resumes.
 */
const MEMORY_VIEW_KEY = "memory-view"
const MEMORY_VIEW_MAX_LINES = 10
/**
 * The interactive browser behind /memory list and /memory search: fetches
 * the facts (search needs the gateway — errors surface as a notification)
 * and mounts the MemoryPanel through ctx.ui.custom until the user quits.
 */
async function openMemoryPanel(
	parsed: Extract<AdminCommand, { op: "list" | "search" }>,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		const facts: MemoryPanelFact[] =
			parsed.op === "search" ? await adminSearchFacts(parsed.query, parsed.scope) : await adminListFacts(parsed.scope)
		const title =
			parsed.op === "search"
				? `Memory — “${parsed.query}” (${facts.length})`
				: `Memory — ${facts.length} fact${facts.length === 1 ? "" : "s"}`
		await ctx.ui.custom(
			(tui, _theme, _keybindings, done) =>
				new MemoryPanel({
					title,
					facts,
					explainFact: async (fact) => {
						const scope =
							fact.scopeId === "personal"
								? { kind: "personal" as const }
								: { kind: "project" as const, scopeId: fact.scopeId }
						const explanation = await adminExplainFact(fact.id, scope)
						if (!explanation) throw new Error(`memory not found or ambiguous: ${fact.id}`)
						return formatMemoryExplanation(explanation)
					},
					deleteFact: async (id) => {
						const outcome = await adminDeleteFacts([id])
						const hit = outcome.deleted[0]
						if (!hit) throw new Error("not found")
						return hit.scope
					},
					tui,
					done: () => done(undefined),
				}),
		)
	} catch (err) {
		ctx.ui.notify(`error: ${err instanceof Error ? err.message : String(err)}`, "error")
	}
}

export function createMemoryExtension(deps: MemoryExtensionDeps = {}): (pi: ExtensionAPI) => void {
	const isEnabled = deps.isEnabled ?? (() => true)

	return function memoryExtension(pi: ExtensionAPI): void {
		// Registered unconditionally — pi rejects unknown extension flags at
		// startup (applyExtensionFlagValues), so "memory" must be known even
		// when the feature is off. Dual-declared with CLI_OPTIONS in
		// cli-args.ts (the kimchi-side parser + help text), same as --yolo/--plan.
		pi.registerFlag("memory", {
			description:
				"Enable persistent personal memory (capture + recall across sessions; facts stored locally, extraction and embedding via the kimchi gateway).",
			type: "boolean",
			default: false,
		})
		if (!isEnabled()) return

		// Session-scoped memory toggle: the /memory command (this surface) and
		// the ACP set_memory_enabled ext-method write the shared override keyed
		// by the sessionManager instance; this runtime reads it at each agent
		// start. lastActive drives flip detection — a flip resets the digest and
		// the delivery ledger so the next start recomputes cleanly. The key is
		// captured at the first agent start (the factory itself has no ctx);
		// before that the default (active) applies.
		let sessionKey: object | undefined
		let lastActive: boolean | undefined
		let recallGeneration = 0
		let activeDeadline: RecallDeadline | undefined
		const beginRecallDeadline = (scheduledStep: string, timeoutMs: number): RecallDeadline => {
			activeDeadline?.cancel("droppedStale")
			const deadline = new RecallDeadline({ scheduledStep, generation: recallGeneration, timeoutMs })
			activeDeadline = deadline
			return deadline
		}
		const finishRecallDeadline = (deadline: RecallDeadline): void => {
			if (activeDeadline?.id === deadline.id) activeDeadline = undefined
			deadline.dispose()
		}
		// Mid-loop recall budget (step trigger): counts received tool results;
		// lastRecallAtStep is the step count when ANY recall path last injected
		// (user-turn + step share it — the K-window suppression is cross-path).
		let loopStepCount = 0
		let lastRecallAtStep = 0
		// Marks the step count at which the last evaluation was CONSUMED —
		// captured at scheduling time, not at body time: tool results keep
		// arriving while a d3 round-trip runs, and the window must anchor
		// to the trigger boundary, not the completion.
		// A consumed-but-clean no-hits window resets the budget too, so
		// thousands of uncovered steps don't queue one evaluation each.
		let lastRecallEvalAtStep = Number.NEGATIVE_INFINITY
		let loopEvalPending = false
		let loopStateRevision = 0
		let observedStateFingerprint: string | undefined
		let lastRecallNeedFingerprint: string | undefined
		let lastRecallNeedEvaluatedAt: number | undefined
		let queuedLoopRecall: { trigger: "step-budget" | "state-revisit"; eligibleAtStep: number } | undefined
		let fingerprintCapReported = false
		let lastLoopEnvTails: string[] = []
		// State-revisit detector: fingerprints of received tool-result state,
		// capped for session lifetime; when a fingerprint repeats, one revisit
		// evaluation is queued (at most once per repeated state).
		let seenFingerprints = new Set<string>()
		let revisitFired = new Set<string>()
		let pendingRevisitTail: string | undefined
		// Serializes mid-loop evaluations so a slow gate search can't stack.
		let loopRecallChain: Promise<void> = Promise.resolve()
		const resetLoopRecallState = (): void => {
			recallGeneration++
			activeDeadline?.cancel("droppedStale")
			activeDeadline = undefined
			loopStepCount = 0
			lastRecallAtStep = 0
			lastRecallEvalAtStep = Number.NEGATIVE_INFINITY
			// Invalidates queued-but-unrun evaluations reading a just-reset
			// budget. loopEvalPending survives — it's topology-only; the
			// generation check handles what was queued.
			lastLoopEnvTails = []
			observedStateFingerprint = undefined
			lastRecallNeedFingerprint = undefined
			lastRecallNeedEvaluatedAt = undefined
			queuedLoopRecall = undefined
			fingerprintCapReported = false
			seenFingerprints = new Set()
			revisitFired = new Set()
			pendingRevisitTail = undefined
		}

		/**
		 * Step-budget trigger: every MEMORY_STEP_RECALL_INTERVAL tool steps,
		 * evaluate the shared recall pipeline with a loop-tail query. Fires
		 * mid-turn via the capture wiring's tool_result producer; one
		 * evaluation at a time via the chain. Suppressed for one full
		 * budget window after ANY recall injection (cross-path), and a
		 * silent no-op while memory is disabled (capture's isActive gate).
		 */
		function handleLoopStep(toolResultText: string, ctx: ExtensionContext): void {
			if (recallFailed) return
			loopStepCount++
			if (toolResultText) {
				const stateFingerprintValue = stateFingerprint(toolResultText)
				if (observedStateFingerprint !== stateFingerprintValue) {
					loopStateRevision++
					observedStateFingerprint = stateFingerprintValue
					if (activeDeadline?.scheduledStep === "step-budget" || activeDeadline?.scheduledStep === "state-revisit") {
						activeDeadline.cancel("droppedStale")
					}
				}
				lastLoopEnvTails = [
					...lastLoopEnvTails,
					// Bounded retention — fingerprints see the kept span; per-use
					// query slicing happens in buildLoopRecallQuery.
					toolResultText.slice(0, MEMORY_STEP_ENV_RECEIPT_KEEP_CHARS),
				].slice(-2)
				// State-revisit detection: a receipt whose fingerprint repeats
				// queues at most one revisit evaluation.
				const fp = stateFingerprint(toolResultText)
				if (fp) {
					if (seenFingerprints.has(fp)) {
						if (!revisitFired.has(fp)) {
							revisitFired.add(fp)
							pendingRevisitTail = toolResultText
						}
					} else if (seenFingerprints.size < stateFingerprintCap()) {
						seenFingerprints.add(fp)
					} else if (!fingerprintCapReported) {
						fingerprintCapReported = true
						console.warn(
							`[memory] state fingerprint cap reached (${stateFingerprintCap()}); only scheduled-step recall remains available`,
						)
					}
				}
			}
			maybeScheduleLoopRecall(ctx)
		}

		/**
		 * Enqueue one mid-loop evaluation. Two triggers share the chain:
		 *   step-budget — when a full window passed since the last consumption
		 *   state-revisit — when a repeated state fingerprint is pending
		 *     (fires at once; revisit is the decision-relevant moment)
		 * Coalescing = at most one evaluation in flight; a trigger that fell
		 * eligible DURING an in-flight evaluation is picked up by the
		 * re-check after completion — results can land far faster than a
		 * d3 gate round-trip.
		 */
		function maybeScheduleLoopRecall(ctx: ExtensionContext): void {
			if (recallFailed) return
			const lastConsumption = Math.max(lastRecallAtStep, lastRecallEvalAtStep)
			const stepDue = loopStepCount - lastConsumption >= stepRecallInterval(process.env)
			const candidate = pendingRevisitTail !== undefined ? "state-revisit" : stepDue ? "step-budget" : undefined
			if (loopEvalPending) {
				if (candidate && (!queuedLoopRecall || loopStepCount < queuedLoopRecall.eligibleAtStep)) {
					queuedLoopRecall = { trigger: candidate, eligibleAtStep: loopStepCount }
				}
				return
			}
			const trigger = queuedLoopRecall?.trigger ?? candidate
			queuedLoopRecall = undefined
			if (!trigger) return
			const revisitTail = trigger === "state-revisit" ? pendingRevisitTail : undefined
			pendingRevisitTail = undefined
			loopEvalPending = true
			const generation = recallGeneration
			lastRecallEvalAtStep = loopStepCount
			loopRecallChain = loopRecallChain
				.then(async () => {
					if (generation !== recallGeneration) return
					if (recallFailed || !memoryActive()) return
					const reasoning = lastAssistantReasoning(ctx)
					const receipts = revisitTail !== undefined ? [revisitTail] : lastLoopEnvTails
					const turnTexts = recentTurnTexts(ctx, loopContextTurns(process.env))
					const query = buildLoopRecallQuery(reasoning, receipts, turnTexts)
					const need = buildLoopRecallNeed(reasoning, receipts, turnTexts)
					const needFingerprint = recallNeedFingerprint(need)
					if (!query) return
					const stateRevision = loopStateRevision
					const now = Date.now()
					if (
						!shouldEvaluateRecallNeed({
							previousFingerprint: lastRecallNeedFingerprint,
							fingerprint: needFingerprint,
							requestedAt: now,
							lastEvaluatedAt: lastRecallNeedEvaluatedAt,
							cooldownMs: MEMORY_LOOP_RECALL_CHANGED_COOLDOWN_MS,
						})
					) {
						console.info("[memory] loop recall skipped: need unchanged or within meaningful-change cooldown")
						return
					}
					lastRecallNeedEvaluatedAt = now
					const deadline = beginRecallDeadline(trigger, MEMORY_LOOP_RECALL_TIMEOUT_MS)
					try {
						const outcome = await runRecall({
							trigger,
							query,
							queries: recallNeedFacets(need),
							pi,
							ctx,
							deadline,
							mayDeliver: () =>
								memoryActive() && generation === recallGeneration && stateRevision === loopStateRevision,
							search: async (q) => {
								const s = await getSearcher()
								if (!s) return undefined
								return s.search(q)
							},
							decideGate: makeRecallGate(query, MEMORY_SEARCH_TIMEOUT_MS, deadline),
							deliveredFacts,
							deliveredKeys,
							onComplete: (completion) => reportProgressiveRecallTelemetry(reportTelemetry, completion),
							emit: async (partial) => {
								const recorder = createRecallRecorder()
								recorder?.emit({
									type: "recall",
									kind: "digest-progressive",
									query,
									...deadline.trace(),
									...partial,
								})
								await recorder?.flush?.()
							},
						})
						if (outcome === "injected" || outcome === "no-hits" || outcome === "covered" || outcome === "gate-skip") {
							lastRecallNeedFingerprint = needFingerprint
						}
						if (outcome === "injected") {
							lastRecallAtStep = lastRecallEvalAtStep
						} else if (outcome === "failed") {
							recallFailed = true
							logDegrade(
								"loop recall failed, disabling mid-loop recall for this session",
								new Error("recall pipeline failure (see trace)"),
							)
						}
					} finally {
						finishRecallDeadline(deadline)
					}
				})
				.catch(() => {
					// runRecall swallows and classifies its own failures; this guards the chain itself.
				})
				.finally(() => {
					loopEvalPending = false
					// Catch-up: a window that fell eligible mid-evaluation.
					if (generation === recallGeneration) maybeScheduleLoopRecall(ctx)
				})
		}
		const memoryActive = (): boolean =>
			sessionKey === undefined ? true : (getSessionMemoryOverride(sessionKey) ?? true)

		// Capture-session attribution: per extension INSTANCE, not module —
		// an ACP server hosts concurrent sessions in one process, and their
		// captures must not merge into one record entry.
		const captureId = deps.captureId ?? randomUUID()
		const reportTelemetry = createMemoryTelemetryReporter((channel, event) => pi.events.emit(channel, event))
		const captureWiring = wireMemoryCapture(
			pi,
			memoryActive,
			handleLoopStep,
			captureId,
			(ctx) => ctx.sessionManager.getSessionId(),
			reportTelemetry,
		)

		// Timing marks are stamped with this session's id — per instance for
		// the same reason as captureId: module state cannot tell concurrent
		// ACP sessions apart. Captured lazily at the first agent start; marks
		// before that (there are none today) fall back to the process id.
		let markSession: string | undefined
		const mark = (event: string, detail?: Record<string, unknown>) => submitTimingMark(event, detail, markSession)

		// In-session management — the same grammar as `kimchi memory` (admin.ts).
		// list|search open the interactive MemoryPanel (page through facts,
		// delete by selection) in TUI mode; everything else — including rpc/ACP
		// contexts, where custom components have no equivalent — renders as
		// read-only output (single-line results as notifications); resets
		// confirm through the native dialog.
		pi.registerCommand("memory", {
			description: "Manage persistent memory (list, search, delete, reset, consolidate, enable, disable)",
			handler: async (args, ctx) => {
				const tokens = args?.trim().split(/\s+/).filter(Boolean) ?? []
				const parsed = parseAdminArgs(tokens, { cwd: ctx.cwd })
				if ((parsed.op === "list" || parsed.op === "search") && !parsed.json && ctx.mode === "tui") {
					await openMemoryPanel(parsed, ctx)
					return
				}
				const result = await runAdminCommand(tokens, {
					cwd: ctx.cwd,
					captureSessionId: captureId,
					confirm: async (message) => ctx.ui.confirm("Memory reset", message),
					memoryState: {
						read: () => getSessionMemoryOverride(ctx.sessionManager),
						setSession: (enabled) => {
							setSessionMemoryOverride(ctx.sessionManager, enabled)
						},
					},
				})
				// A successful reset wiped the store (and, for --scope all, the
				// completion record) — drop the runtime capture state so the segment
				// cannot keep showing counts for just-deleted facts. The digest
				// re-derives against the now-empty store on the next agent start.
				if (parsed.op === "reset" && result.code === 0) {
					digest = undefined
					deliveredKeys.clear()
					deliveredFacts.length = 0
					clearSavedStatus(ctx)
					if (ctx.hasUI) ctx.ui.setStatus(MEMORY_STATUS_KEY, undefined)
				}
				// /memory disable drops the recall count at once — flip detection
				// at the next agent start would clear it too, but a stale count
				// shouldn't linger between management commands.
				if (ctx.hasUI && getSessionMemoryOverride(ctx.sessionManager) === false) {
					ctx.ui.setStatus(MEMORY_STATUS_KEY, undefined)
					clearSavedStatus(ctx)
				}
				const output = result.useJson ? result.json : result.text
				if (!ctx.hasUI) {
					console.log(output)
					return
				}
				const lines = output.split("\n")
				if (lines.length === 1) {
					// A short result is a notification; drop any stale view.
					ctx.ui.setWidget(MEMORY_VIEW_KEY, undefined)
					ctx.ui.notify(output, result.code === 0 ? "info" : "error")
					return
				}
				const shown =
					lines.length <= MEMORY_VIEW_MAX_LINES
						? lines
						: [
								...lines.slice(0, MEMORY_VIEW_MAX_LINES - 1),
								`… ${lines.length - MEMORY_VIEW_MAX_LINES} more lines — run kimchi memory in a terminal for full output`,
							]
				ctx.ui.setWidget(MEMORY_VIEW_KEY, shown)
			},
		})

		// Per-runtime state (closure, like context-assembly's hash fields) —
		// never module-level: each session runtime gets a fresh instance.
		// Three states: undefined = not computed yet, null = computed and
		// nothing cleared the value bar (or the store failed — logged once),
		// set = inject these bytes on every start.
		let digest: DigestState | null | undefined
		let searcher: MemorySearcher | undefined
		let searcherFailed = false
		// Progressive-recall state: the delivery ledger (facts already in
		// context this session) and a failure flag.
		const deliveredKeys = new Set<string>()
		const deliveredFacts: string[] = []
		let recallFailed = false
		// The session's first fact delivery announces itself once ("Recalled N
		// memories"); later recalls only bump the status segment. Never reset —
		// even compaction re-delivery does not re-announce.
		let recallNotified = false
		// Capture feedback: cumulative count of this session's stored facts
		// observed in the worker's completion record — the segment's saved half.
		let savedSeen = 0
		// A drift recall running detached from its turn start — while set, a
		// new uncovered turn doesn't fire a second one. The skipped drift is
		// NOT covered by the in-flight query (it predates those turns), so the
		// newest skip is queued and refired when the chain settles.
		let recallInFlight = false
		let pendingRecallQuery: string | undefined
		// The session's working directory, captured at the first agent start —
		// scopes retrieval to the project store (see createScopedSearcher).
		let sessionCwd: string | undefined
		let agentMemoryMigrationAttempted = false

		// Degrade-path logger. The once-ness comes from caller flags
		// (searcherFailed / recallFailed), not from this helper — the name says
		// what it does. Enough to diagnose, never swallowed (skill rule).
		const logDegrade = (message: string, err: unknown): void => {
			console.error(`[memory] ${message}:`, err instanceof Error ? err.message : err)
		}

		// The d3 gate context for session-scoped gates (digest selection, turn
		// recall gating). Resolved lazily once; a missing config or flag=off
		// leaves every turn-path gate degrading to its pre-gate rule — memory
		// must never break a session. Turn-path timeouts stay inside the
		// outer withTimeout in the start handler (MEMORY_PRE_REQUEST_TIMEOUT_MS
		// for the pre-echo legs, MEMORY_SEARCH_TIMEOUT_MS for the detached
		// search).
		let resolvedDecision: { gate: DecisionGateOptions | null; enabled: ReadonlySet<DecisionGateKind> } | undefined
		const resolveDecision = (): { gate: DecisionGateOptions | null; enabled: ReadonlySet<DecisionGateKind> } => {
			if (deps.decision) return deps.decision()
			if (resolvedDecision) return resolvedDecision
			const parsed = parseDecisionGateFlag(process.env.KIMCHI_MEMORY_DECISION_GATE)
			if (parsed.unknown.length > 0) {
				console.error(`[memory] unknown KIMCHI_MEMORY_DECISION_GATE name(s) ignored: ${parsed.unknown.join(", ")}`)
			}
			if (parsed.enabled.size === 0) {
				resolvedDecision = { gate: null, enabled: parsed.enabled }
				return resolvedDecision
			}
			try {
				const config = loadConfig()
				// A credential-less resolution (no key, no SSO login) is the
				// keyless shape; a gate on it would 401 per call and spam the
				// fail-open logs instead of behaving like "gates unavailable".
				const credentials = resolveGatewayCredentials(config)
				resolvedDecision = credentials.token
					? {
							gate: {
								endpoint: systemoneEndpoint(config.llmEndpoint),
								apiKey: credentials.token,
								organizationId: credentials.organizationId,
								timeoutMs: MEMORY_SEARCH_TIMEOUT_MS / 2,
								maxRetries: 1,
							},
							enabled: parsed.enabled,
						}
					: { gate: null, enabled: parsed.enabled }
			} catch (err) {
				logDegrade("decision-gate config unavailable, memory gates degrading to pre-gate behavior", err)
				resolvedDecision = { gate: null, enabled: parsed.enabled }
			}
			return resolvedDecision
		}

		const clearMemoryView = (ctx: ExtensionContext): void => {
			// The /memory view is transient: clear it once real work resumes
			// (slash commands don't fire agent turns, so it survives between
			// management invocations).
			if (ctx.hasUI) ctx.ui.setWidget(MEMORY_VIEW_KEY, undefined)
		}

		// Status-line segment (MEMORY_STATUS_KEY, shared with
		// src/components/status-line.ts): the number of recalled facts currently
		// in context. Set after any digest / turn-recall delivery, cleared when
		// the delivery ledger empties (toggle flip, compaction) — the segment
		// renders only after memory has actually delivered facts. ACP passes a
		// real uiContext (server.ts bindExtensions), so hasUI is true there and
		// the count reaches IDE clients via the setStatus bridge
		// (acp-ui-context.ts forwards it as _kimchi.dev/pi_notify).
		const updateMemoryStatus = (ctx: ExtensionContext): void => {
			if (!ctx.hasUI) return
			ctx.ui.setStatus(MEMORY_STATUS_KEY, deliveredFacts.length > 0 ? String(deliveredFacts.length) : undefined)
			if (!recallNotified && deliveredFacts.length > 0) {
				recallNotified = true
				ctx.ui.notify(`Recalled ${memoryCountText(deliveredFacts.length)}`, "info")
			}
		}

		// Read the completion record for our capture session and keep the
		// segment's saved half current. The closure value guards against a
		// later drain dropping our entry (record cap).
		const updateSavedStatus = (ctx: ExtensionContext): void => {
			if (!ctx.hasUI) return
			const recorded = readCaptureSessionSaved(captureId)
			if (recorded <= savedSeen) return
			savedSeen = recorded
			ctx.ui.setStatus(MEMORY_SAVED_STATUS_KEY, String(savedSeen))
		}

		// Disable/reset paths clear the saved half alongside the recalled one —
		// a pinned segment must not show a live count for a turned-off (or
		// reset) feature. savedSeen resets too, so re-enabling restores the
		// count from the completion record.
		const clearSavedStatus = (ctx: ExtensionContext): void => {
			savedSeen = 0
			if (!ctx.hasUI) return
			ctx.ui.setStatus(MEMORY_SAVED_STATUS_KEY, undefined)
		}

		const getSearcher = async (): Promise<MemorySearcher | undefined> => {
			if (searcher) return searcher
			if (searcherFailed) return undefined
			if (deps.createSearcher) {
				try {
					searcher = await deps.createSearcher()
				} catch (err) {
					// A throwing factory is a hard failure for this session — mark it
					// so later turns (progressive recall) don't retry it.
					searcherFailed = true
					throw err
				}
				if (!searcher) searcherFailed = true
				return searcher
			}
			try {
				// Scoped retrieval: the personal store plus the current project's
				// store, merged by score (a project-store failure degrades to
				// personal-only inside createScopedSearcher). The cwd is captured at
				// the first agent start; the tool fallback uses personal-only.
				searcher = await createScopedSearcher(sessionCwd ?? "")
				return searcher
			} catch (err) {
				searcherFailed = true
				logDegrade("memory backend unavailable, continuing without memory", err)
				return undefined
			}
		}

		/** Digest selection floor (settled): the decision-model selection call runs
		 * only when the candidate count STRICTLY exceeds the floor; at/below the floor
		 * the pre-gate threshold rule applies untouched (small stores keep recall).
		 * Env: KIMCHI_MEMORY_DIGEST_SELECTION_MIN_CANDIDATES, default 0 = pre-flag. */
		const computeDigest = async (
			query: string,
			deadline: RecallDeadline,
			recorder: TraceRecorder | null,
			telemetry: DigestComputationTelemetry,
		): Promise<DigestState | null | undefined> => {
			const startedAt = Date.now()
			const traceRecall = (partial: Record<string, unknown>): void =>
				recorder?.emit({ type: "recall", kind: "digest-init", query, ...deadline.trace(), ...partial })
			try {
				const s = await getSearcher()
				if (!s) {
					telemetry.noSearcher = true
					traceRecall({
						error: "no-searcher",
						injected: [],
						conclusion: "unreachable",
						durationMs: Date.now() - startedAt,
					})
					return undefined
				}
				// Wide-net digest search when a selection floor is configured: the
				// search default (topK 8) is below any useful floor, which would
				// make the selection gate unreachable for EVERY store size. The
				// widened cap tops out at floor+1 — bounded work, and a store
				// smaller than the floor provably returns at most floor candidates.
				const floor = digestSelectionFloor(process.env)
				telemetry.searchCount = 1
				const hits = await s.search(query, floor > 0 ? floor + 1 : undefined)
				// Digest selection (spike E3/E6/E8): the decision model picks which
				// retrieved candidates earn an injection slot — embedding rank is a
				// weak relevance signal (rank-1 echo, topic twins) and bge-m3 made
				// the score threshold vacuous. A gate failure or timeout falls
				// back to the pre-gate threshold rule for this computation.
				const decision = resolveDecision()
				let selected: ReadonlySet<string> | undefined
				let gateAnswers: Array<{ text: string; choice: string; keepP?: number; injectP?: number }> | undefined
				if (decision.enabled.has("digest") && decision.gate) {
					const scopedGate = {
						...decision.gate,
						timeoutMs: Math.min(decision.gate.timeoutMs ?? MEMORY_SEARCH_TIMEOUT_MS, deadline.remainingMs),
						abortSignal: deadline.signal,
					}
					const candidates = digestCandidateTexts(hits)
					if (shouldRunDigestSelection(candidates.length, floor)) {
						try {
							const answers = await batchChoice(
								scopedGate,
								digestState(query),
								candidates,
								digestQuestion,
								undefined,
								undefined,
								"digest",
							)
							const kept = new Set<string>()
							gateAnswers = []
							for (let i = 0; i < candidates.length; i++) {
								const answer = answers[i]
								gateAnswers.push({
									text: candidates[i] as string,
									choice: answer?.choice ?? "unknown",
									keepP: answer?.probabilities?.keep,
									injectP: answer?.probabilities?.inject,
								})
								if (answer?.choice === "inject") kept.add(candidates[i] as string)
							}
							selected = kept
							telemetry.gateStatus = "passed"
						} catch (err) {
							telemetry.gateStatus = "degraded"
							console.error(
								`[memory] digest selection failed, falling back to the threshold rule:`,
								err instanceof Error ? err.message : err,
							)
						}
					}
				}
				deadline.assertActive()
				const result = buildMemoryDigest(hits, selected)
				if (!result) {
					// Nothing cleared the value bar — inject nothing this session.
					// Recorded so the value measurement sees the no-injection rate.
					const considered = hits.filter((h) => (h.memory ?? "").trim()).length
					const composition: DigestComposition = {
						facts: 0,
						considered,
						belowThreshold: considered,
						selectorSkipped: 0,
						overCap: 0,
						overBudget: 0,
						tokensEstimated: 0,
					}
					telemetry.composition = composition
					console.info(
						`[memory] no digest for this session (belowThreshold=${composition.belowThreshold} of threshold ${DIGEST_SCORE_THRESHOLD})`,
					)
					traceRecall({
						hits: hits.map((h) => ({ text: h.memory, score: h.score })),
						gate: gateAnswers,
						injected: [],
						composition,
						durationMs: Date.now() - startedAt,
					})
					return null
				}
				telemetry.composition = result.composition
				console.info(`[memory] digest selected: ${JSON.stringify(result.composition)}`)
				deadline.markDelivered("selected")
				const selectedIds = selectedFactIds(hits, result.facts)
				traceRecall({
					hits: hits.map((h) => ({ factId: h.id, text: h.memory, score: h.score })),
					gate: gateAnswers,
					selected: result.facts,
					selectedIds,
					injected: [],
					composition: result.composition,
					durationMs: Date.now() - startedAt,
				})
				return {
					text: result.text,
					facts: result.facts,
					factIds: selectedIds,
					composition: result.composition,
					query,
					recallId: deadline.id,
					generation: deadline.generation,
					recorder,
				}
			} catch (err) {
				telemetry.failed = true
				await traceRecall({
					error: err instanceof Error ? err.message : String(err),
					durationMs: Date.now() - startedAt,
				})
				logDegrade("memory search failed, continuing without digest", err)
				// A timed-out computation must stay retryable; a store that was
				// reached but failed definitively does not deserve a retry per turn.
				return deadline.cancellationReason === "timed-out" ? undefined : null
			}
		}

		// Shared d3 gate builder: null = pre-gate behavior (search whenever
		// uncovered). Only owned calls get its signal; absent gates stay absent.
		const makeRecallGate = (
			query: string,
			budgetMs: number,
			deadline: RecallDeadline,
		): (() => Promise<boolean>) | null => {
			const decision = resolveDecision()
			if (!(decision.enabled.has("recall") && (decision.gate || deps.decision))) return null
			return async () => {
				const gate = decision.gate ?? resolveDecision().gate
				if (!gate) return false
				const gateDeadline = new RecallDeadline({
					scheduledStep: "recall-gate",
					generation: deadline.generation,
					timeoutMs: Math.min(budgetMs, deadline.remainingMs),
					parentSignal: deadline.signal,
					id: `${deadline.id}/gate`,
				})
				try {
					const scopedGate = {
						...gate,
						timeoutMs: Math.min(gate.timeoutMs ?? budgetMs, gateDeadline.remainingMs),
						abortSignal: gateDeadline.signal,
					}
					const judged = await awaitRecallDeadline(
						Promise.resolve().then(() =>
							decide(scopedGate, recallState(deliveredFacts.join("\n"), query), recallQuestion(), "recall"),
						),
						gateDeadline,
					)
					return judged.answers.lookup?.choice === "skip"
				} finally {
					gateDeadline.dispose()
				}
			}
		}

		const attachDigest = async (state: DigestState, systemPrompt: string): Promise<{ systemPrompt: string }> => {
			if (systemPrompt.includes(state.text)) {
				state.recorder?.emit({
					type: "recall",
					kind: "digest-init",
					phase: "before_agent_start",
					recall_id: state.recallId,
					generation: state.generation,
					injected: state.facts,
					injectedIds: state.factIds,
					conclusion: "attachedToTurn",
					attachedToTurn: true,
				})
				await state.recorder?.flush?.()
			}
			return { systemPrompt }
		}

		pi.on("before_agent_start", async (event, ctx) => {
			// upstream pi: the event fires for extension-triggered runs too and is a
			// union — memory digests/recall key off user prompts only.
			if (event.messageType !== "user") return
			markSession ??= ctx.sessionManager.getSessionId()
			clearMemoryView(ctx)
			// Only explicit lifecycle resets (toggle/compaction) invalidate an
			// in-flight generation. A newer prompt in the same session must not
			// cancel an already-running recall; it coalesces for the next window.
			// Capture the session cwd once — scopes retrieval to the project store.
			sessionCwd ??= ctx.cwd
			// Session-scoped toggle: capture the key once, then re-read the shared
			// override every start (the /memory command or the ACP
			// set_memory_enabled ext-method may flip it between turns). A flip
			// resets the digest, the delivery ledger, and the incremental mark so
			// the next start recomputes cleanly; while disabled the session runs
			// with no memory contribution at all (no digest, no notice, no
			// capture, no recall) — earlier turns keep what they already sent
			// (accepted cache break; deliberate user action).
			//
			// The key is the sessionManager OBJECT, not a session id string: the
			// /memory command (this runtime) and the ACP server
			// (set_memory_enabled) both hold the same instance for one session
			// runtime, so object identity is the one key both sides already share
			// without agreeing on an id accessor — and the WeakMap entry dies with
			// the session (see session-toggle.ts).
			sessionKey ??= ctx.sessionManager
			const active = memoryActive()
			if (active !== lastActive) {
				reportTelemetry({
					event: "session_state",
					active,
					authoredEnabled: authoredEnabled(),
					reason: lastActive === undefined ? "initial" : "toggle",
				})
				if (lastActive !== undefined) {
					digest = undefined
					deliveredKeys.clear()
					deliveredFacts.length = 0
					pendingRecallQuery = undefined
					resetLoopRecallState()
					// The flip emptied the ledger — drop any stale count.
					updateMemoryStatus(ctx)
					clearSavedStatus(ctx)
				}
				lastActive = active
			}
			if (!active) return

			// One-time migration from the legacy agent-memory system (per-agent
			// MEMORY.md) into the personal store — awaited so migrated content is
			// searchable from this session's first digest. Steady state is a single
			// marker-file stat; never allowed to break the turn.
			if (!agentMemoryMigrationAttempted) {
				agentMemoryMigrationAttempted = true
				try {
					await withTimeout(migrateAgentMemory(), 30_000, "agent memory migration")
				} catch {
					// One-time best effort — retried next session on failure.
				}
			}
			// Lever 3: drain new content as it accumulates (sync, cheap — reads
			// the in-memory entries and spawns a detached worker past the mark),
			// — the same increment the turn_end/tool_result hooks evaluate;
			// all three producers share the wiring-owned mark.
			captureWiring.fireIncrement(ctx)

			// Capture feedback: read the drain's completion record (per-session
			// counts) — bump the segment's saved half.
			updateSavedStatus(ctx)

			// Turn 1 (awaited): the prefix carries the digest from the very first
			// request, so later turns never see a prompt change.
			if (digest === undefined) {
				mark("memory.digest.begin")
				const generation = recallGeneration
				const deadline = beginRecallDeadline("before-agent-start", MEMORY_PRE_REQUEST_TIMEOUT_MS)
				const recorder = createRecallRecorder()
				const digestStartedAt = Date.now()
				const digestTelemetry: DigestComputationTelemetry = {
					gateStatus: "not_run",
					searchCount: 0,
					noSearcher: false,
					failed: false,
				}
				let outcome: DigestState | null | undefined
				try {
					outcome = await withRecallDeadline(deadline, () =>
						awaitRecallDeadline(computeDigest(event.prompt, deadline, recorder, digestTelemetry), deadline),
					)
					if (generation !== recallGeneration || !memoryActive()) outcome = undefined
				} catch (err) {
					outcome = undefined
					if (deadline.cancellationReason === "timed-out") {
						console.error(`[memory] digest computation timed out after ${MEMORY_PRE_REQUEST_TIMEOUT_MS}ms`)
					} else {
						logDegrade("memory digest computation failed", err)
					}
					recorder?.emit({
						type: "recall",
						kind: "digest-init",
						error: err instanceof Error ? err.message : String(err),
						...deadline.trace(),
					})
				} finally {
					finishRecallDeadline(deadline)
				}
				mark("memory.digest.end", outcome === undefined ? { conclusion: deadline.conclusion } : undefined)
				if (outcome === undefined) {
					const stale = generation !== recallGeneration || !memoryActive()
					const outcomeName: MemoryRecallOutcome = stale
						? "dropped_stale"
						: deadline.cancellationReason === "timed-out"
							? "timed_out"
							: deadline.cancellationReason === "droppedStale"
								? "dropped_stale"
								: deadline.cancellationReason === "cancelled"
									? "cancelled"
									: digestTelemetry.noSearcher
										? "no_searcher"
										: "failed"
					reportInitialDigestTelemetry(reportTelemetry, {
						outcome: outcomeName,
						delivery: "none",
						durationMs: Date.now() - digestStartedAt,
						state: undefined,
						details: digestTelemetry,
					})
					return { systemPrompt: `${event.systemPrompt}${MEMORY_ENABLED_NOTICE}` }
				}
				digest = outcome
				if (digest) {
					for (const fact of digest.facts) {
						deliveredKeys.add(factKey(fact))
						deliveredFacts.push(fact)
					}
				}
				updateMemoryStatus(ctx)
				if (digest === null) {
					reportInitialDigestTelemetry(reportTelemetry, {
						outcome: digestTelemetry.failed ? "failed" : "no_hits",
						delivery: "none",
						durationMs: Date.now() - digestStartedAt,
						state: null,
						details: digestTelemetry,
					})
					return { systemPrompt: `${event.systemPrompt}${memoryEnabledNotice()}` }
				}
				const response = await attachDigest(digest, `${event.systemPrompt}${digest.text}${memoryEnabledNotice()}`)
				reportInitialDigestTelemetry(reportTelemetry, {
					outcome: "delivered",
					delivery: "attached",
					durationMs: Date.now() - digestStartedAt,
					state: digest,
					details: digestTelemetry,
				})
				return response
			}

			if (!recallFailed) {
				// The drift signal is the recent conversation — the new prompt
				// plus the tail of the last assistant response (the model may
				// drive the conversation somewhere the delivered facts don't
				// cover). Bounded, with each half capped separately: the tail cap
				// keeps code-heavy responses out of the embedding payload, and the
				// prompt head gets whatever remains of the total cap — a long
				// prompt (stack trace, spec paste) must never push the tail out.
				const responseTail = lastAssistantText(ctx).slice(-TURN_RECALL_RESPONSE_CHARS)
				const promptHead = event.prompt.slice(0, TURN_RECALL_QUERY_MAX_CHARS - responseTail.length - 1)
				const recent = `${promptHead}\n${responseTail}`

				// The gate→search→delivery chain runs DETACHED from the turn
				// start (#1701): the request never waits on retrieval; the steer
				// arrives when ready. Drift skipped while one runs coalesces
				// (last-wins) into pendingRecallQuery and refires on settle.
				const fireDetachedRecall = (query: string): void => {
					recallInFlight = true
					// Anchor the suppression window at FIRE time: a settle-time read
					// stretches the step budget past K for slow recollections.
					const fireStep = loopStepCount
					const generation = recallGeneration
					// Serialize with the loop scheduler's chain: both paths touch the
					// same delivery ledger — detached and step recalls must never
					// interleave delivery mutations.
					const run = loopRecallChain.then(async () => {
						let deadline: RecallDeadline | undefined
						try {
							if (generation !== recallGeneration || !memoryActive()) return
							deadline = beginRecallDeadline("user-turn", MEMORY_SEARCH_TIMEOUT_MS)
							const outcome = await runRecall({
								trigger: "user-turn",
								query,
								pi,
								ctx,
								deadline,
								mayDeliver: () => memoryActive() && generation === recallGeneration,
								search: async (q) => {
									const s = await getSearcher()
									if (!s) return undefined
									return s.search(q)
								},
								decideGate: makeRecallGate(query, MEMORY_PRE_REQUEST_TIMEOUT_MS, deadline),
								deliveredFacts,
								deliveredKeys,
								onComplete: (completion) => reportProgressiveRecallTelemetry(reportTelemetry, completion),
								emit: async (partial) => {
									const recorder = createRecallRecorder()
									recorder?.emit({
										type: "recall",
										kind: "digest-progressive",
										query,
										...deadline?.trace(),
										...partial,
									})
									await recorder?.flush?.()
								},
							})
							if (outcome === "injected") {
								// Cross-path suppression: a user-turn injection blocks the
								// step trigger for one full budget window (K = interval);
								// monotonic: a concurrently-anchored step injection's
								// newer anchor is never rewound by this settle.
								lastRecallAtStep = Math.max(lastRecallAtStep, fireStep)
								updateMemoryStatus(ctx)
							} else if (outcome === "failed") {
								throw new Error("recall pipeline failure (see trace)")
							}
						} catch (err) {
							recallFailed = true
							logDegrade("turn recall failed, disabling progressive recall for this session", err)
						} finally {
							if (deadline) finishRecallDeadline(deadline)
							recallInFlight = false
							// Refire only current-generation coalesced drift.
							if (!recallFailed && memoryActive() && pendingRecallQuery !== undefined) {
								const next = pendingRecallQuery
								pendingRecallQuery = undefined
								if (isCovered(next, deliveredFacts)) {
									console.info("[memory] coalesced recall skipped: settled recall covered the deferred drift")
								} else {
									fireDetachedRecall(next)
								}
							}
						}
					})
					loopRecallChain = run.catch((err) => {
						console.error("[memory] user-turn recall chain rejected:", err instanceof Error ? err.message : err)
					})
				}
				if (recallInFlight) {
					pendingRecallQuery = recent
					console.info("[memory] turn recall deferred: previous recall still in flight — drift coalesced for refire")
				} else {
					fireDetachedRecall(recent)
				}
			}

			if (digest === null) {
				return { systemPrompt: `${event.systemPrompt}${memoryEnabledNotice()}` }
			}
			return attachDigest(digest, `${event.systemPrompt}${digest.text}${memoryEnabledNotice()}`)
		})

		pi.on("session_compact", (_event, ctx) => {
			// The prefix breaks at compaction anyway — recompute the digest
			// against the post-compaction state on the next agent start, and
			// reset the delivery ledger: earlier recall steers may have been
			// compacted away, so re-delivery is allowed.
			digest = undefined
			deliveredKeys.clear()
			deliveredFacts.length = 0
			pendingRecallQuery = undefined
			resetLoopRecallState()
			captureWiring.resetIncrement()
			// The ledger reset means nothing is in context — clear the count
			// until the next agent start recomputes the digest.
			updateMemoryStatus(ctx)
		})

		pi.registerTool(
			createMemorySearchTool({
				search: async (query) => {
					const s = await getSearcher()
					if (!s) return []
					return s.search(query)
				},
				// The session toggle gates the tool too — a disabled memory reports
				// its state instead of a misleading "no memories" result.
				isEnabled: memoryActive,
				reportTelemetry,
			}),
		)

		// Authored lane (flag-gated, default OFF): the model writes its own
		// durable findings with save_memory. Personal store, [authored]
		// provenance prefix in the text so digests show the source; the
		// quality gates stay on the passive lane — an authored fact is already
		// intent-filtered by the model itself.
		if (authoredEnabled()) {
			type WriterBackend = Awaited<ReturnType<typeof createMemoryBackend>>
			let writer: WriterBackend | undefined
			const getWriter = async (): Promise<WriterBackend> => {
				if (!writer) writer = await createMemoryBackend({ dbPath: memoryDbPath("personal") })
				return writer
			}
			// The dedupe list is fetched once per registration and cached
			// (invalidated on every write — the cached snapshots then feed
			// checks inside createMemorySaveTool without an extra full getAll
			// for every save_memory call).
			let existingCache: string[] | undefined
			pi.registerTool(
				createMemorySaveTool({
					write: async (text) => {
						const w = await getWriter()
						await w.add(text, { userId: MEMORY_USER_ID, infer: false })
						if (existingCache) {
							existingCache.push(text)
						} else {
							const { results } = await w.getAll({ filters: { user_id: MEMORY_USER_ID }, topK: 100_000 })
							existingCache = results.map((r) => r.memory ?? "")
						}
					},
					existing: async () => {
						if (existingCache) return existingCache
						const w = await getWriter()
						const { results } = await w.getAll({ filters: { user_id: MEMORY_USER_ID }, topK: 100_000 })
						existingCache = results.map((r) => r.memory ?? "")
						return existingCache
					},
					isEnabled: memoryActive,
					reportTelemetry,
				}),
			)
		}
	}
}

export default function memoryExtension(pi: ExtensionAPI): void {
	createMemoryExtension()(pi)
}

/** Notice selection: the authored-lane variant ONLY when its flag is on —
 * the flag-OFF default keeps the "no write tool" wording, so the prompt
 * never contradicts the registered tool surface (and stays byte-identical
 * to the pre-flag shape). */
export function memoryEnabledNotice(env: NodeJS.ProcessEnv = process.env): string {
	return authoredEnabled(env) ? MEMORY_ENABLED_NOTICE_AUTHORED : MEMORY_ENABLED_NOTICE
}

/** The last assistant response, or "" — one more drift signal for the gate. */
function lastAssistantText(ctx: ExtensionContext): string {
	try {
		const entries = ctx.sessionManager.getEntries()
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]
			if (entry.type !== "message" || entry.message.role !== "assistant") continue
			return messageText(entry.message.content)
		}
	} catch {
		// Entries unavailable (e.g. in-memory session) — the prompt alone
		// grounds this turn's gate.
	}
	return ""
}

/** Mid-loop reasoning head: text when present, else the thinking lane.
 * Reasoning-lane agents deliberate in thinking blocks — an empty text
 * lane collapses the loop query to bare env echoes (shot evidence from
 * live traces: queries of just `pressed: down×6 | step 19`). Mirrors
 * the capture lane's thinkingText: read `text ?? thinking` per block. */
function lastAssistantReasoning(ctx: ExtensionContext): string {
	const text = lastAssistantText(ctx)
	if (text.trim()) return text
	try {
		const entries = ctx.sessionManager.getEntries()
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]
			if (entry.type !== "message" || entry.message.role !== "assistant") continue
			const content = entry.message.content
			if (!Array.isArray(content)) return ""
			const lines: string[] = []
			for (const block of content as Array<{ type?: string; text?: string; thinking?: string }>) {
				if (block?.type === "thinking") {
					const thinking = block.thinking ?? block.text
					if (thinking) lines.push(thinking)
				}
			}
			return lines.join("\n")
		}
	} catch {
		// Same tolerance as lastAssistantText.
	}
	return ""
}

/**
 * Recent conversation turns as recall context facets (Chunk A: the
 * multi-message embedding context). Walks entries backwards collecting
 * user + assistant message texts, skips the LATEST assistant entry (its
 * reasoning is already the query head), and returns at most `count`
 * summaries. Textless turns (pure tool steps) are skipped without
 * consuming the budget; any parse failure degrades to [].
 */
function recentTurnTexts(ctx: ExtensionContext, count: number): string[] {
	if (count <= 0) return []
	try {
		const entries = ctx.sessionManager.getEntries()
		const texts: string[] = []
		let seenLatestAssistant = false
		for (let i = entries.length - 1; i >= 0 && texts.length < count; i--) {
			const entry = entries[i]
			if (entry.type !== "message") continue
			const msg = entry.message
			if (msg.role !== "assistant" && msg.role !== "user") continue
			if (msg.role === "assistant" && !seenLatestAssistant) {
				seenLatestAssistant = true
				continue
			}
			const content = msg.content
			let text = ""
			if (typeof content === "string") text = content
			else if (Array.isArray(content)) {
				for (const block of content as Array<{ type?: string; text?: string; thinking?: string }>) {
					const t = block?.text ?? block?.thinking
					if (t) {
						text = t
						break
					}
				}
			}
			text = text.trim()
			if (text) texts.push(text)
		}
		return texts
	} catch {
		return []
	}
}
