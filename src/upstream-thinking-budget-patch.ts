/**
 * thinking-budget patch — bounds the *reasoning* a single provider turn may emit.
 *
 * Companion to extensions/max-output-tokens.ts. That extension caps total output
 * via `max_tokens`, which is blunt: a limit tight enough to stop runaway
 * deliberation also severs tool calls. This one measures only thinking, so the
 * budget can be far stricter — the turn that reasons briefly and then acts is
 * never touched.
 *
 * ── Why a patch rather than an extension ────────────────────────────────────
 * There is no server-side budget to ask for: the gateway accepts
 * `reasoning: {max_tokens}` and `thinking: {budget_tokens}` with HTTP 200 and
 * ignores both, and pi's `thinkingBudgets` is unimplemented for
 * openai-completions. So the stream has to be stopped client-side, and the
 * extension API has no stream hook — `message_update` can only watch, and its
 * one lever, `ctx.abort()`, trips the run's own controller. An "aborted" turn
 * ends the whole run before the steering queue is polled, which under `--print`
 * exits 1. Aborting a private controller and synthesizing a `done`/"length"
 * event instead leaves the run intact and reads as an ordinary truncation.
 *
 * ── Why compaction is excluded ──────────────────────────────────────────────
 * `agent.streamFn` also drives manual compaction, auto-compaction and branch
 * summarization, where a capped summary would silently destroy context. Only
 * the agent loop passes the run's own signal, which is what `isAgentTurn` tests.
 *
 * ── Why usage is estimated ──────────────────────────────────────────────────
 * openai-completions fills `usage` from the final chunk alone, so a mid-stream
 * abort leaves it zeroed — and compaction's `getAssistantUsage` accepts
 * "length" messages, so that zero would become the session's authoritative last
 * usage: context accounting collapses to ~0, auto-compaction stops firing, and
 * max-output-tokens.ts sends a full cap against a nearly-full window. Estimating
 * high is the safe direction, since it only shrinks the next cap.
 *
 * Reasoning emitted as <think> text (see extensions/hide-thinking.ts) arrives as
 * `text_delta` and is deliberately not counted — counting it would cut a model
 * mid-answer. Such models, and non-reasoning ones, fall through untouched.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageDiagnostic,
	type AssistantMessageEvent,
	calculateCost,
	createAssistantMessageEventStream,
	type Model,
	type streamSimple,
	type Usage,
} from "@earendil-works/pi-ai"
import { AgentSession, estimateTokens } from "@earendil-works/pi-coding-agent"
import { resolveMaxThinkingTokens } from "./models.js"

/**
 * pi-agent-core's StreamFn, redeclared rather than imported: that package is
 * only a transitive dependency, and importing it by name breaks under stricter
 * dependency resolution, and therefore in CI.
 */
type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>

type StreamOptions = Parameters<StreamFn>[2]
type StreamContext = Parameters<StreamFn>[1]

/** Repo-wide estimation convention — see estimateTokens in extensions/model-guard.ts. */
export const CHARS_PER_TOKEN = 4

/**
 * Insurance against a provider that ignores the abort signal, which would
 * otherwise hang the run forever. The openai path never needs it: its SSE
 * iterator swallows the abort, so the provider settles promptly on its own.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000

export const THINKING_BUDGET_DIAGNOSTIC_TYPE = "kimchi_thinking_budget_truncation"

let suppressNextTurn = false

/**
 * Exempt the next agent turn from the budget. Called once steering has given up,
 * where a still-capped turn would be cut off again with nothing left to recover
 * it and the run would end empty-handed; one conceded turn is the cheaper trade.
 *
 * Process-scoped, like the breaker in upstream-retry-patch.ts. Concurrent
 * subagents could in principle consume each other's exemption, which costs one
 * uncapped turn — not worth threading session identity through the patch for.
 */
export function suppressThinkingBudgetForNextTurn(): void {
	suppressNextTurn = true
}

/** @internal Exported for tests. */
export function __resetSuppression(): void {
	suppressNextTurn = false
}

export interface ThinkingBudgetStreamOptions {
	/**
	 * Whether this call is an agent turn rather than a summarization. Only agent
	 * turns are capped; see the header.
	 */
	isAgentTurn: (options: StreamOptions) => boolean
	/** Defaults to reading the environment per call. */
	resolveBudget?: () => number
	drainTimeoutMs?: number
}

/**
 * Scratch fields the openai-completions provider hangs off tool-call blocks
 * while streaming. It strips them itself on the paths that settle normally; the
 * drain-timeout fallback reads a block mid-flight, so it has to strip its own.
 */
const SCRATCH_BLOCK_FIELDS = ["index", "partialArgs", "streamIndex"] as const

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}
}

function sanitizeBlock(block: AssistantMessage["content"][number]): AssistantMessage["content"][number] {
	const copy: Record<string, unknown> = { ...block }
	for (const field of SCRATCH_BLOCK_FIELDS) delete copy[field]
	return copy as unknown as AssistantMessage["content"][number]
}

/**
 * Tokens the prompt is worth, reusing pi's own estimator so this does not drift
 * from the figure compaction and the context gauge already work with.
 */
function estimateUsage(model: Model<Api>, context: StreamContext, message: AssistantMessage): Usage {
	let input = Math.ceil((context.systemPrompt?.length ?? 0) / CHARS_PER_TOKEN)
	// Tool definitions are part of the prompt but not of `messages`. Omitting them
	// measured ~40% below the usage the provider reports for the same request, and
	// under-counting input is the unsafe direction: it leaves max-output-tokens.ts
	// believing there is more headroom than there is.
	if (context.tools?.length) {
		input += Math.ceil(JSON.stringify(context.tools).length / CHARS_PER_TOKEN)
	}
	for (const contextMessage of context.messages) {
		// pi's Message and AgentMessage overlap on every role that reaches a
		// provider request; estimateTokens switches on `role` alone.
		input += estimateTokens(contextMessage as Parameters<typeof estimateTokens>[0])
	}
	const output = estimateTokens(message as Parameters<typeof estimateTokens>[0])
	const usage: Usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}
	// Mutates usage.cost in place and returns it.
	calculateCost(model, usage)
	return usage
}

/**
 * Wrap a stream function so an agent turn is cut short once its thinking
 * exceeds `budget` tokens. Exported separately from the patch so it can be
 * tested without an AgentSession.
 */
export function createThinkingBudgetStreamFn(inner: StreamFn, options: ThinkingBudgetStreamOptions): StreamFn {
	const resolveBudget = options.resolveBudget ?? resolveMaxThinkingTokens
	const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS

	return async (model, context, streamOptions) => {
		// Compaction and branch summaries pass through untouched. Checked before the
		// exemption so a summary cannot consume a turn's one-shot exemption.
		if (!options.isAgentTurn(streamOptions)) {
			return inner(model, context, streamOptions)
		}
		if (suppressNextTurn) {
			suppressNextTurn = false
			return inner(model, context, streamOptions)
		}
		const budget = resolveBudget()
		if (budget <= 0) {
			return inner(model, context, streamOptions)
		}

		const controller = new AbortController()
		const callerSignal = streamOptions?.signal
		// Forwarded by hand rather than via AbortSignal.any, which the packaged
		// binary's runtime may not have. The caller's signal lives for the whole run,
		// so the listener has to come off again once the turn settles.
		const forwardAbort = () => controller.abort()
		if (callerSignal) {
			if (callerSignal.aborted) controller.abort()
			else callerSignal.addEventListener("abort", forwardAbort, { once: true })
		}

		let underlying: Awaited<ReturnType<StreamFn>>
		try {
			underlying = await inner(model, context, { ...streamOptions, signal: controller.signal })
		} catch (error) {
			callerSignal?.removeEventListener("abort", forwardAbort)
			throw error
		}

		const out = createAssistantMessageEventStream()

		let thinkingChars = 0
		let tripped = false
		let settled = false
		let lastPartial: AssistantMessage | undefined
		let drainTimer: ReturnType<typeof setTimeout> | undefined
		// Tool calls that finished streaming before we tripped. The provider's abort
		// path parses partial arguments into a plausible-looking object, so a
		// half-streamed call cannot be told from a complete one by inspection.
		const completedToolCalls = new Set<number>()

		const settleTruncated = (base: AssistantMessage) => {
			if (settled) return
			settled = true
			if (drainTimer) clearTimeout(drainTimer)

			const content = base.content
				.map(sanitizeBlock)
				.filter((block, index) => block.type !== "toolCall" || completedToolCalls.has(index))
			const usageEstimated = !base.usage || base.usage.totalTokens <= 0
			const estimatedThinkingTokens = Math.ceil(thinkingChars / CHARS_PER_TOKEN)
			const diagnostic: AssistantMessageDiagnostic = {
				type: THINKING_BUDGET_DIAGNOSTIC_TYPE,
				timestamp: Date.now(),
				details: { budget, thinkingChars, estimatedThinkingTokens, usageEstimated },
			}
			const message: AssistantMessage = {
				...base,
				content,
				stopReason: "length",
				errorMessage: undefined,
				usage: usageEstimated ? estimateUsage(model, context, { ...base, content }) : base.usage,
				diagnostics: [...(base.diagnostics ?? []), diagnostic],
			}

			out.push({ type: "done", reason: "length", message })
			out.end(message)
		}

		const settlePassThrough = (event: AssistantMessageEvent | undefined, fallback?: AssistantMessage) => {
			if (settled) return
			settled = true
			if (drainTimer) clearTimeout(drainTimer)
			if (event) out.push(event)
			// A stream that ended without a terminal event still has to resolve, or
			// the agent loop waits on result() forever.
			out.end(fallback)
		}

		void (async () => {
			try {
				let terminal: AssistantMessageEvent | undefined
				for await (const event of underlying) {
					if (event.type === "done" || event.type === "error") {
						terminal = event
						break
					}
					out.push(event)
					if ("partial" in event) lastPartial = event.partial

					if (tripped) continue
					if (event.type === "toolcall_end") {
						completedToolCalls.add(event.contentIndex)
						continue
					}
					if (event.type !== "thinking_delta") continue

					thinkingChars += event.delta.length
					if (Math.ceil(thinkingChars / CHARS_PER_TOKEN) <= budget) continue

					tripped = true
					controller.abort()
					// Insurance only; the provider normally settles well within this.
					// `lastPartial` is always set here — this very event carried one.
					const partialAtTrip = event.partial
					drainTimer = setTimeout(() => {
						const base = lastPartial ?? partialAtTrip
						settleTruncated({ ...base, content: [...base.content] })
					}, drainTimeoutMs)
				}

				// Rewriting a user's Esc as "length" would have the loop carry on after
				// the run was told to stop.
				if (!tripped || callerSignal?.aborted) {
					// Pushing the terminal event resolves result() on its own payload;
					// a stream that ended without one needs the fallback to resolve it.
					settlePassThrough(terminal, terminal ? undefined : await underlying.result())
					return
				}

				// Better than the last partial: the abort path finalizes blocks first,
				// so arguments are parsed and scratch fields stripped.
				settleTruncated(await underlying.result())
			} catch (error) {
				if (settled) return
				settled = true
				if (drainTimer) clearTimeout(drainTimer)
				// Built field by field rather than spread from `lastPartial`, which is
				// undefined when the stream throws before its first event. Consumers of
				// message_end read `usage` without guarding (llm-response-log.ts), so a
				// half-formed message here would throw inside their handler.
				const message: AssistantMessage = {
					role: "assistant",
					content: lastPartial?.content ?? [],
					api: lastPartial?.api ?? model.api,
					provider: lastPartial?.provider ?? model.provider,
					model: lastPartial?.model ?? model.id,
					usage: lastPartial?.usage ?? emptyUsage(),
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: lastPartial?.timestamp ?? Date.now(),
				}
				out.push({ type: "error", reason: "error", error: message })
				out.end(message)
			} finally {
				callerSignal?.removeEventListener("abort", forwardAbort)
			}
		})()

		return out
	}
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

const WRAPPED = Symbol.for("kimchi.thinkingBudgetWrapped")

interface PatchableAgent {
	streamFn?: StreamFn & { [WRAPPED]?: boolean }
	readonly signal?: AbortSignal
}

interface PatchableSession {
	agent?: PatchableAgent
}

interface PatchableSessionPrototype {
	_installAgentToolHooks?: (this: PatchableSession) => unknown
	_kimchiThinkingBudgetPatch?: boolean
}

export interface ThinkingBudgetPatchOptions {
	sessionClass?: { prototype: PatchableSessionPrototype }
	drainTimeoutMs?: number
	resolveBudget?: () => number
}

/**
 * Wrap one agent's stream function, once.
 *
 * Session switch, fork and reload each construct a fresh AgentSession around a
 * fresh Agent, so the marker is per-agent rather than per-prototype.
 */
export function wrapAgentStreamFn(agent: PatchableAgent, options: ThinkingBudgetPatchOptions = {}): void {
	const original = agent.streamFn
	if (typeof original !== "function" || original[WRAPPED]) return

	const wrapped = createThinkingBudgetStreamFn(original, {
		// The agent loop is the only caller that passes the run's own signal;
		// compaction and branch summarization pass their own controllers.
		isAgentTurn: (streamOptions) => Boolean(streamOptions?.signal) && streamOptions?.signal === agent.signal,
		resolveBudget: options.resolveBudget,
		drainTimeoutMs: options.drainTimeoutMs,
	}) as StreamFn & { [WRAPPED]?: boolean }
	wrapped[WRAPPED] = true
	agent.streamFn = wrapped
}

/**
 * Patch AgentSession so every session's agent gets a thinking-budgeted stream —
 * subagents and ACP sessions included, since they use this same class.
 *
 * `_installAgentToolHooks` runs from the constructor once `this.agent` exists,
 * making it the earliest point with an agent to wrap. A `streamFn` accessor on
 * Agent.prototype would not work: it is a class field, so [[Define]] semantics
 * shadow any accessor before the constructor assigns it.
 */
export function installThinkingBudgetPatch(options: ThinkingBudgetPatchOptions = {}): void {
	const sessionClass = options.sessionClass ?? (AgentSession as unknown as { prototype: PatchableSessionPrototype })
	const proto = sessionClass.prototype

	if (typeof proto._installAgentToolHooks !== "function") {
		throw new Error(
			"pi-coding-agent AgentSession internals are incompatible with the Kimchi thinking budget " +
				"(missing AgentSession._installAgentToolHooks() — upstream internals changed)",
		)
	}
	if (proto._kimchiThinkingBudgetPatch) return

	const original = proto._installAgentToolHooks
	proto._installAgentToolHooks = function patchedInstallAgentToolHooks(this: PatchableSession) {
		if (this.agent) wrapAgentStreamFn(this.agent, options)
		return original.call(this)
	}
	proto._kimchiThinkingBudgetPatch = true
}
