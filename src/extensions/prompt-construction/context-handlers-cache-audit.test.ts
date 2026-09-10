/**
 * Transient context-handler cache audit (replay technique).
 *
 * For each context handler, drives the REAL registered `context` test path
 * over a synthesized growing session and measures, at the byte level:
 *
 *  1. Prefix growth: no-state-change rounds must strictly prefix-extend the
 *     previous request body (any deviation = cache invalidation at that
 *     position).
 * 2. Bounded transitions: config/state flips (strip toggles, mid-history
 *     nudges aging out, resume) must cause at most one bounded invalidation.
 * 3. Idempotency: the same resolved history must produce the same bytes on
 *     every round.
 * 4. History integrity (in-place mutators): the original history objects
 *     must not be mutated — upstream emitContext() deep-clones; our fires do
 *     the same via structuredClone.
 *
 * Byte comparison runs on JSON.stringify(convertToLlm(...)) — the exact
 * array that gets serialized into the request body (cache_control marker
 * placement is pi-ai-fixed at sys/tools/tail, so it doesn't affect the
 * relative stability we measure here; verified by
 * anthropic-prefix-cache.test.ts for the full wire path).
 */
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai"
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { convertToLlm } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import hideThinkingExtension, { _resetState, _setHideThinking } from "../hide-thinking.js"
import modelGuardExtension from "../model-guard.js"
import {
	brandUnmarkedSteers,
	NUDGE_CUSTOM_TYPE,
	stripStaleNudges,
	stripUiOnlyMessages,
	tagSelfEchoes,
} from "../orchestration/continuation-nudge.js"
import toolRenderingExtension from "../tool-rendering.js"

// ─── Fixtures ────────────────────────────────────────────────────────────────

type AgentMessage = ContextEvent["messages"][number]
type OrchestratorMessages = ContextEvent["messages"]
type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>

let ts = 1000
const nextTs = () => ts++

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: nextTs() } as unknown as AgentMessage
}

function userMessageWithImage(text: string, imageTag: string): AgentMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text },
			{ type: "image", data: `b64_${imageTag}`, mimeType: "image/png" } as ImageContent,
		],
		timestamp: nextTs(),
	} as unknown as AgentMessage
}

function assistantText(text: string): AgentMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		content: [{ type: "text", text } as TextContent],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: nextTs(),
	} as unknown as AgentMessage
}

function assistantToolCall(callId: string): AgentMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: `echo ${callId}` } }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: nextTs(),
	} as unknown as AgentMessage
}

function toolResult(callId: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text }],
		timestamp: nextTs(),
	} as unknown as AgentMessage
}

function customMessage(customType: string, content: string): AgentMessage {
	return { role: "custom", customType, content, display: false, timestamp: nextTs() } as unknown as AgentMessage
}

/** Mirrors upstream emitContext: every context fire sees a fresh deep clone. */
function cloneForFire(messages: OrchestratorMessages): OrchestratorMessages {
	return structuredClone(messages)
}

// ─── Harness ─────────────────────────────────────────────────────────────────

function createPiHarness(register: (pi: ExtensionAPI) => void, ctx: ExtensionContext) {
	const handlers = new Map<string, ExtensionHandler[]>()
	const stubCache = new Map<string, unknown>()
	// Auto-stub every pi member (extensions register commands, tools, shortcuts,
	// events...) while capturing `on(...)` handler registrations for firing.
	const pi = new Proxy({ sendMessage: vi.fn(), appendEntry: vi.fn() } as Record<string, unknown>, {
		get(target, prop: string) {
			if (prop === "on") {
				return (event: string, handler: ExtensionHandler) => {
					const list = handlers.get(event) ?? []
					list.push(handler)
					handlers.set(event, list)
				}
			}
			if (prop in target) return target[prop]
			if (!stubCache.has(prop)) stubCache.set(prop, vi.fn())
			return stubCache.get(prop)
		},
	}) as unknown as ExtensionAPI
	register(pi)

	async function fire(event: string, payload: unknown): Promise<unknown> {
		let result: unknown
		let currentPayload = payload
		for (const handler of handlers.get(event) ?? []) {
			result = await handler(currentPayload, ctx)
			const contextResult = result as { messages?: OrchestratorMessages } | undefined
			if (event === "context" && contextResult?.messages) {
				currentPayload = { ...(currentPayload as object), messages: contextResult.messages }
			}
		}
		return result
	}

	/** The model-visible view for the next LLM call: every registered context
	 *  handler runs over a fresh deep clone; both `{messages}` returns AND
	 *  in-place mutations of the payload get carried through (this is exactly
	 *  upstream's emitContext semantics). */
	async function contextView(history: OrchestratorMessages): Promise<OrchestratorMessages> {
		const list = handlers.get("context") ?? []
		const payload: { type: string; messages: OrchestratorMessages } = {
			type: "context",
			messages: cloneForFire(history),
		}
		for (const handler of list) {
			const result = (await handler(payload, ctx)) as { messages?: OrchestratorMessages } | undefined
			if (result?.messages) payload.messages = result.messages
		}
		return payload.messages
	}

	return { pi, fire, contextView }
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

/** Converted-request byte string (with cache_control-free content). */
function bodyBytes(messages: OrchestratorMessages): string {
	return JSON.stringify(convertToLlm(structuredClone(messages)))
}

interface RoundMetrics {
	/** True when this round's body strictly contains the previous round's body as a byte prefix. */
	containsPrior: boolean
	/** -1 when identical, else first differing byte index. */
	firstDivergence: number
	bodyLength: number
}

async function measureRounds(
	historySteps: Array<AgentMessage[]>,
	pipeline: (history: OrchestratorMessages) => Promise<OrchestratorMessages>,
): Promise<{ metrics: RoundMetrics[]; bodies: string[] }> {
	const bodies: string[] = []
	const metrics: RoundMetrics[] = []
	let prev = ""
	for (const history of historySteps) {
		const body = bodyBytes(await pipeline(history as OrchestratorMessages))
		if (prev === "") {
			metrics.push({ containsPrior: false, firstDivergence: -1, bodyLength: body.length })
		} else {
			let div = -1
			if (body !== prev) {
				const n = Math.min(body.length, prev.length)
				for (let i = 0; i < n; i++) {
					if (body[i] !== prev[i]) {
						div = i
						break
					}
				}
				if (div === -1 && body.length < prev.length) div = body.length
			}
			// JSON arrays are closed strings: the extended body's byte-prefix
			// relation holds against prev-minus-its-closing-']', not the full
			// prev (this is exactly how the simulateCache prefix containment in
			// anthropic-prefix-cache.test.ts works).
			const prevCore = prev.endsWith("]") ? prev.slice(0, -1) : prev
			metrics.push({
				containsPrior: body.startsWith(prevCore) && body.length > prev.length,
				firstDivergence: div,
				bodyLength: body.length,
			})
		}
		bodies.push(body)
		prev = body
	}
	return { metrics, bodies }
}

/** Sequential history snapshots: each round appends the next fixed chunk. */
function growHistory(seed: AgentMessage[], rounds: AgentMessage[][]): AgentMessage[][] {
	const steps: AgentMessage[][] = []
	let current = [...seed]
	for (const chunk of rounds) {
		current = [...current, ...chunk]
		steps.push([...current])
	}
	return steps
}

const growth = (i: number): AgentMessage[] => [assistantToolCall(`c-${i}`), toolResult(`c-${i}`, `out-${i}`)]

// ─── model-guard ─────────────────────────────────────────────────────────────

function modelGuardCtx(model: Partial<Model<Api>>): ExtensionContext {
	return createContext({
		model: { id: "claude-sonnet-5", name: "claude-sonnet-5", ...model },
	})
}

describe("audit: model-guard context handler", () => {
	it("steady state (vision model, no images): never modifies — strict prefix growth", async () => {
		const ctx = modelGuardCtx({ input: ["text", "image"], contextWindow: 200_000 })
		const harness = createPiHarness(modelGuardExtension, ctx)
		const { metrics } = await measureRounds(
			growHistory([userMessage("u1")], [growth(1), growth(2), growth(3)]),
			harness.contextView,
		)
		expect(metrics.slice(1).every((m) => m.containsPrior)).toBe(true)
	})

	it("non-vision model with an image in history: deterministic strip; stable across rounds", async () => {
		const ctx = modelGuardCtx({ input: ["text"], contextWindow: 200_000 })
		const harness = createPiHarness(modelGuardExtension, ctx)
		const seed = [userMessageWithImage("look", "picA"), assistantText("ok")]
		const steps = growHistory(seed, [growth(1), growth(2)])
		const { metrics, bodies } = await measureRounds(steps, harness.contextView)
		expect(metrics.slice(1).every((m) => m.containsPrior)).toBe(true)
		// The strip actually happened (placeholder replaces the image bytes).
		expect(bodies[1]).toContain("[image removed:")
		expect(bodies[1]).not.toContain("b64_picA")
	})

	it("emergency truncation regime (oversized context): per-round invalidation — documented emergency path", async () => {
		const ctx = modelGuardCtx({ input: ["text"], contextWindow: 120 })
		const harness = createPiHarness(modelGuardExtension, ctx)
		// Each message ≈ 600 chars ≈ 150 estimated tokens → the estimate always
		// exceeds the 120-token window, keeping the emergency truncate path hot.
		const long = (s: string) => s.repeat(600)
		const steps = growHistory(
			[userMessage(long("u"))],
			[[assistantText(long("a"))], [assistantText(long("b"))], [assistantText(long("c"))]],
		)
		const { metrics, bodies } = await measureRounds(steps, harness.contextView)
		// Sanity: the truncate path is genuinely engaged (notice emitted).
		expect(bodies.at(-1)).toContain("Context truncated")
		// In this regime EVERY round rewrites from a fresh cutoff → prefix is
		// not preserved (cache is unfixable while oversized; compaction owns growth).
		const breaks = metrics.slice(1).filter((m) => !m.containsPrior).length
		expect(breaks).toBeGreaterThan(0)
	})
})

// ─── prompt-enrichment strips ────────────────────────────────────────────────

/** The orchestrator chain as registered for claude targets (no kimi branch). */
async function stripChain(history: OrchestratorMessages): Promise<OrchestratorMessages> {
	let messages = stripStaleNudges(cloneForFire(history))
	messages = stripUiOnlyMessages(messages)
	messages = tagSelfEchoes(messages)
	messages = brandUnmarkedSteers(messages)
	return messages
}

describe("audit: prompt-enrichment strips (orchestrator chain)", () => {
	it("empty-turn nudge aging out: exactly one bounded tail-adjacent invalidation, then stable growth", async () => {
		const nudge = customMessage(NUDGE_CUSTOM_TYPE, "nudge text")
		// R1 ends with the nudge still tail. R2 appends an assistant reply →
		// nudge becomes stale and is stripped → bounded invalidation AT the
		// nudge position (tail-adjacent). R3+ resume strict growth.
		// Shared object references across steps: persisted history entries are
		// the SAME objects (fixed timestamps) in every round — building fresh
		// per-step fixtures would model a history that doesn't exist.
		const s0 = userMessage("u1")
		const a1 = assistantToolCall("a1")
		const r1 = toolResult("a1", "ok")
		const a2 = assistantToolCall("a2")
		const r2 = toolResult("a2", "ok")
		const steps = [
			[s0, nudge],
			[s0, nudge, a1, r1],
			[s0, nudge, a1, r1, a2, r2],
		]
		const { metrics, bodies } = await measureRounds(steps, stripChain)
		expect(metrics[1]?.containsPrior).toBe(false) // nudge aged out → one invalidation
		expect(metrics[2]?.containsPrior).toBe(true) // growth resumed
		// The divergence lands at the nudge's own position in the R1 body —
		// i.e. bounded, tail-adjacent, not a full-context rewrite: the shared
		// user-turn prefix survives intact.
		const div = metrics[1]?.firstDivergence ?? -1
		// convertToLlm folds custom → user role (customType is not in the wire
		// body), so locate the nudge by its content text
		const nudgePos = (bodies[0] ?? "").indexOf("nudge text")
		expect(div).toBeGreaterThan(0)
		expect(div).toBeLessThanOrEqual(nudgePos)
		expect(bodies[1]).not.toContain("nudge text")
	})

	it("ui-only customs + unmarked steer: deterministic transforms; strict growth across rounds", async () => {
		const steps = growHistory(
			[userMessage("u1"), customMessage("ferment_breadcrumb", "crumb"), customMessage("plain-steer", "unbranded")],
			[growth(1), growth(2), growth(3)],
		)
		const { metrics, bodies } = await measureRounds(steps, stripChain)
		expect(metrics.slice(1).every((m) => m.containsPrior)).toBe(true)
		expect(bodies[0]).not.toContain("crumb") // ui-only stripped
		expect(bodies[0]).toContain("<system-reminder>") // unmarked steer branded
	})

	it("self-echo tagging: deterministic across rounds (no per-round volatility)", async () => {
		const echo = "Identify yourself briefly."
		const steps = growHistory([assistantText(echo), userMessage(echo)], [growth(1), growth(2)])
		const { metrics, bodies } = await measureRounds(steps, stripChain)
		expect(metrics.slice(1).every((m) => m.containsPrior)).toBe(true)
		expect(bodies[1]).toContain("verbatim echo")
	})
})

// ─── hide-thinking ───────────────────────────────────────────────────────────

function thinkMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		content: [{ type: "text", text: `intro <think>${text}</think> outro` }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: nextTs(),
	} as unknown as AssistantMessage
}

describe("audit: hide-thinking restore path", () => {
	it("same-session (shadow map intact): restored originals → strict prefix growth", async () => {
		_resetState()
		_setHideThinking(true)
		const ctx = createContext({ hasUI: true })
		const harness = createPiHarness(hideThinkingExtension, ctx)

		const persisted = (await harness.fire("message_end", { message: thinkMessage("plan A") })) as
			| { message: AssistantMessage }
			| undefined
		const historyEntry = persisted?.message as unknown as AgentMessage
		expect(JSON.stringify(historyEntry)).not.toContain("plan A") // display text persisted

		const steps = growHistory([userMessage("u1"), historyEntry], [growth(1), growth(2)])
		const { metrics, bodies } = await measureRounds(steps, harness.contextView)
		expect(metrics.slice(1).every((m) => m.containsPrior)).toBe(true)
		expect(bodies[1]).toContain("plan A") // original restored on the wire
	})

	it("resumed process (shadow map empty): thinking is NOT restored → one resume-boundary invalidation; hide=false leaves ANSI in LLM context", async () => {
		_resetState()
		_setHideThinking(true)
		const ctx = createContext({ hasUI: true })
		const harness = createPiHarness(hideThinkingExtension, ctx)
		const persisted = (await harness.fire("message_end", { message: thinkMessage("plan B") })) as
			| { message: AssistantMessage }
			| undefined
		const historyEntry = persisted?.message as unknown as AgentMessage

		// Emulate a process restart: shadow map is in-memory only.
		_resetState()
		_setHideThinking(true)

		const steps = growHistory([userMessage("u1"), historyEntry], [growth(1), growth(2)])
		const { metrics, bodies } = await measureRounds(steps, harness.contextView)
		// No restore after restart → the wire keeps the stripped display text.
		expect(bodies[1]).not.toContain("plan B")
		// Still stable across rounds (deterministic lossy view).
		expect(metrics.slice(1).every((m) => m.containsPrior)).toBe(true)

		// dim-mode (hideThinking=false) persists ANSI-escaped display text.
		_resetState()
		_setHideThinking(false)
		const persistedDim = (await harness.fire("message_end", { message: thinkMessage("plan C") })) as
			| { message: AssistantMessage }
			| undefined
		_resetState()
		_setHideThinking(false)
		const dimBodies = (
			await measureRounds(
				growHistory([persistedDim?.message as unknown as AgentMessage], [growth(1)]),
				harness.contextView,
			)
		).bodies
		expect(dimBodies[0]).toContain("\\u001b[") // ANSI codes leak to the model after restart
	})
})

// ─── tool-rendering ──────────────────────────────────────────────────────────

describe("audit: tool-rendering in-place context mutation", () => {
	it("thinking artifacts + legacy duration lines: idempotent stable view; history objects untouched", async () => {
		const ctx = createContext({ hasUI: true })
		const harness = createPiHarness(toolRenderingExtension, ctx)

		const dirtyThinking: AgentMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-5",
			content: [
				{ type: "thinking", thinking: "\x1b[2mthinking: hidden work\x1b[0m", thinkingSignature: "" },
				{ type: "text", text: "done\n\n\x1b[38;5;8m✻ Worked for 12s\x1b[0m" },
			],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: nextTs(),
		} as unknown as AgentMessage
		const beforeHistory = JSON.stringify(dirtyThinking)

		const history: AgentMessage[] = [userMessage("u1"), dirtyThinking]
		const steps = growHistory(history, [growth(1), growth(2)])
		const { metrics, bodies } = await measureRounds(steps, harness.contextView)

		// Stable, byte-reproducible transformed view every round.
		expect(metrics.slice(1).every((m) => m.containsPrior)).toBe(true)
		expect(bodies[1]).not.toContain("\\u001b[2mthinking:")
		// In-place mutation is confined to the context clone: history intact.
		expect(JSON.stringify(dirtyThinking)).toBe(beforeHistory)
	})
})
