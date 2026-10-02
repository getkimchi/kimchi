/**
 * Integration: unattended background-bash exit delivery against the REAL
 * installed agent loop.
 *
 * What is REAL here (installed @earendil-works/pi-agent-core@0.85.1, resolved
 * through the SDK's dependency path exactly like the queue probe):
 *  - the `Agent` steering/follow-up queues and their one-at-a-time draining,
 *  - the core `runLoop`: steering is consumed at the top of the inner loop —
 *    after tool results are pushed, BEFORE the next assistant response — and
 *    `message_start`/`message_end` are emitted for each injected message
 *    before it is pushed into the run context (agent-loop.js runLoop),
 *  - tool execution, `afterToolCall`, and result ordering,
 *  - the full bash-control extension + background bash tool + shared
 *    terminal-delivery state.
 *
 * What is faked: the model stream (scripted assistant messages), the process
 * backend (`FakeOps`), and the `AgentSession` layer — replaced by a dispatch
 * that mirrors the installed `AgentSession.sendCustomMessage` exactly:
 *
 *   streaming + triggerTurn !== false → deliverAs "followUp" ? agent.followUp
 *                                          : agent.steer            (steer)
 *   idle + triggerTurn              → _runAgentPrompt → agent.prompt([msg])
 *   idle + !triggerTurn             → _appendCustomMessage (append, emit
 *                                       message_start/message_end)
 *
 * Acknowledgement seam (verified in the installed sources, documented in
 * terminal-delivery.ts): `message_end` for a custom message is emitted by
 * the loop right before the message joins the run context, so it is the
 * earliest point at which the outcome is committed to the conversation the
 * NEXT provider request will see. The `tool_result` event (afterToolCall)
 * plays the same role for control-owned outcomes.
 */
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createFakeOps, type FakeOps } from "./__mocks__/fake-bash-ops.js"
import { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
import bashControlExtension from "./bash-control-extension.js"
import { createProcessRegistry } from "./process-registry.js"
import { createReviewCoordinator } from "./review-coordinator.js"
import type { BashSessionState } from "./session-registry.js"
import { createTerminalDelivery } from "./terminal-delivery.js"

// pi-agent-core is a transitive dependency: resolve it through the installed
// SDK's path (pnpm keeps them as siblings in .pnpm) — a direct package import
// would break under pnpm's strict resolution (see continuation-nudge.ts).

/** Structural view of the installed Agent — the dynamically imported module
 *  is untyped, so the harness pins exactly the surface it uses. */
interface AgentLike {
	state: { messages: unknown[]; isStreaming: boolean }
	prompt: (input: unknown) => Promise<void>
	steer: (m: unknown) => void
	followUp: (m: unknown) => void
	abort: () => void
	clearAllQueues: () => void
	subscribe: (l: (event: Record<string, unknown>) => Promise<void>) => () => void
}
type AgentConstructor = new (options: Record<string, unknown>) => AgentLike

async function loadAgent(): Promise<AgentConstructor> {
	const { realpathSync } = await import("node:fs")
	const { resolve } = await import("node:path")
	const { pathToFileURL } = await import("node:url")
	const sdkPath = realpathSync("node_modules/@earendil-works/pi-coding-agent")
	const moduleUrl = pathToFileURL(resolve(sdkPath, "../pi-agent-core/dist/agent.js")).href
	const mod = (await import(/* @vite-ignore */ moduleUrl)) as { Agent: AgentConstructor }
	return mod.Agent
}

const ctx = createContext()
const CWD = "/tmp/bash-background-integration"

/** One scripted provider request: what the fake model returns + what it saw. */
interface RequestRecord {
	round: number
	/** Whether the unique terminal marker was visible in THIS request's context. */
	markerVisible: boolean
}

/** A scripted assistant response. */
interface ScriptedResponse {
	stopReason: "toolUse" | "stop" | "aborted"
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
}

/** The unique terminal marker — emitted as process OUTPUT only, never in a
 *  command, so command summaries in early results cannot leak it. */
const MARKER = "TRAIN-DONE-MARKER-7f3a"

interface IntegrationHarness {
	agent: AgentLike
	/** Per-request visibility log (the decisive assertions read this). */
	requests: RequestRecord[]
	/** message_end events for exit notifications (insertion evidence). */
	exitMessageEnds: Array<{ details: unknown; replaced: boolean }>
	state: BashSessionState
	ops: FakeOps
	pi: ReturnType<typeof createExtensionApi>
}

function scriptStreamFn(harness: { requests: RequestRecord[]; script: ScriptedResponse[] }) {
	let round = 0
	return async (_model: unknown, llmContext: { messages: unknown[] }, config: { signal?: AbortSignal }) => {
		round += 1
		harness.requests.push({
			round,
			markerVisible: llmContext.messages.some((m) => JSON.stringify(m).includes(MARKER)),
		})
		const scripted = harness.script.shift()
		if (!scripted) throw new Error(`fake model has no scripted response for round ${round}`)
		// An aborted signal overrides the script: the provider stream aborts.
		const stopReason = config.signal?.aborted ? "aborted" : scripted.stopReason
		const message = {
			role: "assistant",
			provider: "fake",
			model: "fake",
			api: "fake",
			timestamp: Date.now(),
			stopReason,
			content: (scripted.toolCalls ?? []).map((call) => ({
				type: "toolCall",
				id: call.id,
				name: call.name,
				arguments: call.arguments,
			})),
		}
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "done" as const, message }
			},
			result: async () => message,
		}
	}
}

/** Mutate `target` in place from `replacement` (mirrors _replaceMessageInPlace). */
function replaceInPlace(target: Record<string, unknown>, replacement: Record<string, unknown>): void {
	for (const key of Object.keys(target)) delete target[key]
	Object.assign(target, replacement)
}

async function setupIntegration(script: ScriptedResponse[]): Promise<IntegrationHarness> {
	const Agent = await loadAgent()
	const ops = createFakeOps()
	const registry = createProcessRegistry()
	const coordinator = createReviewCoordinator({ registry, handoffSeconds: 0.05 })
	const delivery = createTerminalDelivery()
	const state: BashSessionState = { registry, coordinator, delivery, limitSeconds: 3600, cwd: CWD }

	const pi = createExtensionApi()
	const requests: RequestRecord[] = []
	const exitMessageEnds: IntegrationHarness["exitMessageEnds"] = []

	const harness: IntegrationHarness = {
		agent: undefined as unknown as AgentLike,
		requests,
		exitMessageEnds,
		state,
		ops,
		pi,
	}

	// The extension under test, wired to the shared session state.
	bashControlExtension(pi.api, { getState: () => state })
	await pi.emit("session_start", {}, ctx)

	// Register the real background `bash` tool; the harness's own bash tool
	// (this test file's runner) is not involved.
	const bashTool = createBackgroundBashToolDefinition(CWD, { state, operations: ops })
	const bashControlTool = pi.getRegisteredTools().find((t) => t.name === "bash_control") as ToolDefinition

	// A deterministic "independent work" tool: sleeps briefly so unattended
	// exits triggered at its tool_execution_start land mid-execution (while
	// the model keeps making tool calls).
	const readTool = {
		name: "read",
		description: "independent work",
		parameters: { type: "object" as const, properties: {}, additionalProperties: false },
		execute: async () => {
			await new Promise((resolve) => setTimeout(resolve, 30))
			return { content: [{ type: "text", text: "independent work done" }] }
		},
	}

	const streamFn = scriptStreamFn({ requests, script })

	// Event forwarding: Agent events → extension handlers, mirroring the
	// installed AgentSession._emitExtensionEvent translation (incl. the
	// message_end replacement hook, applied in place before the loop pushes
	// the message into the run context).
	let turnIndex = 0
	const agent = new Agent({
		streamFn,
		convertToLlm: (messages: Array<Record<string, unknown>>) =>
			// Mirrors the installed session: custom → user verbatim.
			messages
				.filter((m) => ["user", "assistant", "toolResult", "custom"].includes(String(m.role)))
				.map((m) => (m.role === "custom" ? { role: "user", content: m.content, timestamp: m.timestamp } : m)),
		initialState: {
			systemPrompt: "",
			messages: [],
			model: {
				id: "fake",
				name: "fake",
				api: "fake",
				provider: "fake",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
			tools: [bashTool, readTool, bashControlTool],
		},
		beforeToolCall: async ({ toolCall }: { toolCall: { id: string; name: string; arguments: unknown } }) => {
			await pi.emit(
				"tool_call",
				{
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
					input: toolCall.arguments,
				},
				ctx,
			)
			return undefined
		},
		afterToolCall: async ({
			toolCall,
			result,
		}: {
			toolCall: { id: string; name: string }
			result: { content?: unknown; details?: unknown }
		}) => {
			await pi.emit(
				"tool_result",
				{
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: {},
					content: result.content ?? [],
					details: result.details,
					isError: false,
				},
				ctx,
			)
			return undefined
		},
	})

	const unsubscribe = agent.subscribe(async (event: Record<string, unknown>) => {
		switch (event.type) {
			case "agent_start":
				await pi.emit("agent_start", { type: "agent_start" }, ctx)
				break
			case "turn_start":
				await pi.emit("turn_start", { type: "turn_start", turnIndex: turnIndex++, timestamp: Date.now() }, ctx)
				break
			case "message_end": {
				const message = event.message as Record<string, unknown>
				const isExit = message.role === "custom" && message.customType === "bash-background-exit"
				const results = await pi.emit("message_end", { type: "message_end", message }, ctx)
				const replacement = results.find(
					(r): r is { message: Record<string, unknown> } =>
						typeof r === "object" && r !== null && "message" in (r as Record<string, unknown>),
				)
				if (replacement) {
					// The installed runtime applies message_end replacements
					// in place (agent state, loop context, persistence).
					replaceInPlace(message, replacement.message)
				}
				if (isExit) exitMessageEnds.push({ details: message.details, replaced: replacement !== undefined })
				break
			}
			case "turn_end":
				await pi.emit(
					"turn_end",
					{
						type: "turn_end",
						turnIndex: turnIndex - 1,
						message: event.message,
						toolResults: event.toolResults ?? [],
					},
					ctx,
				)
				break
			case "tool_execution_start":
				await pi.emit(
					"tool_execution_start",
					{
						type: "tool_execution_start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
					},
					ctx,
				)
				break
			case "tool_execution_end":
				await pi.emit(
					"tool_execution_end",
					{
						type: "tool_execution_end",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result ?? {},
					},
					ctx,
				)
				break
			default:
				break
		}
	})

	// Dispatch mirroring installed AgentSession.sendCustomMessage (see the
	// module docstring for the exact installed branches).
	pi.sendMessage.mockImplementation(
		(message: Record<string, unknown>, options?: { triggerTurn?: boolean; deliverAs?: string }) => {
			const appMessage = {
				role: "custom",
				customType: message.customType,
				content: (message.content as unknown[]) ?? [],
				display: message.display,
				details: message.details,
				timestamp: Date.now(),
			}
			if (agent.state.isStreaming && options?.triggerTurn !== false) {
				if (options?.deliverAs === "followUp") agent.followUp(appMessage)
				else agent.steer(appMessage)
			} else if (options?.triggerTurn) {
				void agent.prompt([appMessage]).catch((err: unknown) => {
					throw err instanceof Error ? err : new Error(String(err))
				})
			} else if (agent.state.isStreaming) {
				// The installed session defers the append to turn end; our
				// paths never send a streaming no-trigger message.
				throw new Error("unexpected streaming append in test harness")
			} else {
				// _appendCustomMessage (installed SDK): commits the message to
				// agent state + session persistence and notifies session
				// LISTENERS — but does NOT dispatch extension message_end handlers
				// (verified: it uses the listener emit directly, not
				// _emitExtensionEvent). The harness mirrors that exactly.
				agent.state.messages.push(appMessage)
			}
		},
	)

	harness.agent = agent
	// Keep the subscription referenced so it is not garbage-collected mid-run.
	void unsubscribe
	return harness
}

/**
 * Install a tool_execution_start hook that exits the named background
 * process (emitting the marker) when `triggerTool` starts executing — the
 * unattended exit lands mid-execution while the model keeps calling tools.
 */
function exitDuringTool(
	harness: IntegrationHarness,
	triggerTool: string,
	commandNeedle: string,
	extra?: { alsoAbortAndClearQueues?: boolean },
): void {
	const origEmit = harness.pi.emit.bind(harness.pi)
	let triggered = false
	harness.pi.emit = async (event: string, payload: unknown, context?: unknown) => {
		const p = payload as { toolName?: string }
		if (event === "tool_execution_start" && p?.toolName === triggerTool && !triggered) {
			triggered = true
			harness.ops.emitMatching(commandNeedle, `${MARKER}\n`)
			await harness.ops.exitMatching(commandNeedle, 0)
			if (extra?.alsoAbortAndClearQueues) {
				// Let the exit watcher + delivery flush enqueue the steering
				// message, then the user aborts and the TUI/ACP drop queued
				// steering (clearQueue/clearAllQueues before session.abort()).
				await new Promise((resolve) => setTimeout(resolve, 20))
				harness.agent.abort()
				harness.agent.clearAllQueues()
			}
		}
		return origEmit(event, payload, context as ExtensionContext)
	}
}

describe("background bash exit delivery (real installed agent loop)", () => {
	let registry: BashSessionState["registry"] | undefined
	let consoleError: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		// Keep expected failure-path logs out of the test output.
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(async () => {
		consoleError.mockRestore()
		if (registry) await registry.shutdown()
		registry = undefined
	})

	it("delivers an unattended exit to the NEXT provider request while tools keep being called", async () => {
		// The decisive starvation regression: the process exits unattended
		// AFTER its handoff, while the assistant keeps making independent
		// tool calls. The terminal marker must reach a provider request
		// BEFORE the scripted tool-free stop. (With the old followUp
		// delivery the marker stayed invisible through every tool-bearing
		// request and appeared only after the stop — the queue probe
		// demonstrates exactly that failure on this same installed loop.)
		const harness = await setupIntegration([
			{ stopReason: "toolUse", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "train" } }] },
			{ stopReason: "toolUse", toolCalls: [{ id: "c2", name: "read", arguments: {} }] },
			{ stopReason: "toolUse", toolCalls: [{ id: "c3", name: "read", arguments: {} }] },
			{ stopReason: "stop" },
		])
		registry = harness.state.registry
		exitDuringTool(harness, "read", "train")

		await harness.agent.prompt([
			{ role: "user", content: [{ type: "text", text: "run the training" }], timestamp: Date.now() },
		])

		expect(harness.requests.map((r) => r.round)).toEqual([1, 2, 3, 4])
		// Rounds 1–2 cannot see the exit (it happens during round 2's tools).
		expect(harness.requests[0]?.markerVisible).toBe(false)
		expect(harness.requests[1]?.markerVisible).toBe(false)
		// THE regression: round 3 — a request BEFORE the scripted stop —
		// already contains the terminal marker.
		expect(harness.requests[2]?.markerVisible).toBe(true)
		expect(harness.requests[3]?.markerVisible).toBe(true)

		// Insertion + payload identity: exactly one exit notification,
		// acknowledged via message_end (not replaced), and retired.
		expect(harness.exitMessageEnds.filter((e) => !e.replaced)).toHaveLength(1)
		expect(harness.state.delivery.hasPending()).toBe(false)
		const markerMessages = harness.agent.state.messages.filter((m) => JSON.stringify(m).includes(MARKER))
		expect(markerMessages).toHaveLength(1)
		expect((markerMessages[0] as { role?: string }).role).toBe("custom")
	})

	it("recovers a dropped exit notification after an abort through an explicit inspection (no duplicate)", async () => {
		// Kimchi's TUI (Escape) and ACP (cancel) DROP queued steering when
		// the user aborts. The exit lands during the run's tool execution,
		// the run is aborted and the queue cleared before consumption: the
		// outcome must stay pending+recoverable, never restart inference,
		// and a later explicit bash_control inspection delivers it exactly
		// once.
		const harness = await setupIntegration([
			{ stopReason: "toolUse", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "recover" } }] },
			{ stopReason: "toolUse", toolCalls: [{ id: "c2", name: "read", arguments: {} }] },
			// Consumed by the aborted round-3 request (signal overrides the
			// script), which ends the first run.
			{ stopReason: "stop" },
			// Second (recovery) run: an explicit inspection, then settle.
			{ stopReason: "toolUse", toolCalls: [{ id: "c3", name: "bash_control", arguments: { wait: false } }] },
			{ stopReason: "stop" },
		])
		registry = harness.state.registry
		exitDuringTool(harness, "read", "recover", { alsoAbortAndClearQueues: true })

		await harness.agent.prompt([{ role: "user", content: [{ type: "text", text: "train" }], timestamp: Date.now() }])

		// The aborted run ended without consuming the notification: no
		// provider request ever saw the marker…
		expect(harness.requests.some((r) => r.markerVisible)).toBe(false)
		// …no exit notification was inserted into the conversation…
		expect(harness.exitMessageEnds).toHaveLength(0)
		// …and the outcome survived as recoverable (available), process gone.
		const handle = harness.state.delivery.pendingHandles()[0]
		expect(handle).toBeTruthy()
		expect(harness.state.delivery.getPending(handle as string)?.phase).toBe("available")
		expect(harness.state.registry.getEntry(handle as string)).toBeUndefined()
		expect(harness.agent.state.isStreaming).toBe(false)

		// Explicit recovery: a fresh user run whose model inspects the
		// cohort. The recorded outcome delivers through the tool result.
		harness.requests.length = 0
		await harness.agent.prompt([
			{ role: "user", content: [{ type: "text", text: "collect results" }], timestamp: Date.now() },
		])
		// First request of the recovery run: the dropped message is gone,
		// the marker is not visible yet…
		expect(harness.requests[0]?.markerVisible).toBe(false)
		// …the inspection tool result carries the payload…
		const toolResultMessages = harness.agent.state.messages.filter(
			(m) => (m as { role?: string }).role === "toolResult" && JSON.stringify(m).includes(MARKER),
		)
		expect(toolResultMessages).toHaveLength(1)
		// …so the final request of the recovery run sees it.
		expect(harness.requests[1]?.markerVisible).toBe(true)
		// Retired through the tool_result acknowledgement: nothing pending.
		expect(harness.state.delivery.hasPending()).toBe(false)
		// Exactly one marker-bearing message in the whole conversation —
		// no duplicate from a late automatic delivery.
		expect(harness.agent.state.messages.filter((m) => JSON.stringify(m).includes(MARKER))).toHaveLength(1)
	})

	it("follows steering queue order behind an earlier steer without claiming delivery early", async () => {
		// An advisory steer already sits ahead of the exit notification in
		// the one-at-a-time steering queue: the exit arrives one turn later
		// than the immediate case — still WITHOUT a tool-free model stop —
		// and its pending state is never reported as delivered before
		// consumption.
		const harness = await setupIntegration([
			{ stopReason: "toolUse", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "train-fifo" } }] },
			// Round 2: a write tool while the tracked process runs — this
			// enqueues the once-per-turn concurrency steer AHEAD of the exit.
			{ stopReason: "toolUse", toolCalls: [{ id: "c2", name: "bash", arguments: { command: "touch side-file" } }] },
			{ stopReason: "toolUse", toolCalls: [{ id: "c3", name: "read", arguments: {} }] },
			{ stopReason: "stop" },
		])
		registry = harness.state.registry

		// Both processes exit unattended in the same scheduling boundary
		// during round 3's read tool: the marker process and the side-file
		// joiner coalesce into ONE identified batch message.
		const origEmit = harness.pi.emit.bind(harness.pi)
		let exited = false
		harness.pi.emit = async (event: string, payload: unknown, context?: unknown) => {
			const p = payload as { toolName?: string }
			if (event === "tool_execution_start" && p?.toolName === "read" && !exited) {
				exited = true
				harness.ops.emitMatching("train-fifo", `${MARKER}\n`)
				// Both execs settle synchronously so both exit watchers join the
				// SAME microtask flush boundary → one coalesced notification.
				const first = harness.ops.exitMatching("train-fifo", 0)
				const second = harness.ops.exitMatching("side-file", 0)
				await Promise.all([first, second])
			}
			return origEmit(event, payload, context as never)
		}

		await harness.agent.prompt([
			{ role: "user", content: [{ type: "text", text: "run and touch" }], timestamp: Date.now() },
		])

		expect(harness.requests.map((r) => r.round)).toEqual([1, 2, 3, 4])
		// Round 3's request sees the concurrency steer queued ahead — the
		// exit is NOT visible yet (queue order, never claimed early).
		expect(harness.requests[2]?.markerVisible).toBe(false)
		// Round 4 — still a tool-bearing request sequence before the stop —
		// sees the exit marker. No model stop was required.
		expect(harness.requests[3]?.markerVisible).toBe(true)
		// Delivered exactly once, acknowledged, retired.
		expect(harness.state.delivery.hasPending()).toBe(false)
		expect(harness.agent.state.messages.filter((m) => JSON.stringify(m).includes(MARKER))).toHaveLength(1)
	})

	it("a post-abort exit appends without restarting inference and retires without message_end", async () => {
		// The user aborts while the process is still RUNNING (the TUI/ACP also
		// drop queued steering, but nothing is queued here). The process then
		// exits unattended while the session is idle and terminated: the
		// payload must be appended to the conversation WITHOUT waking
		// inference, and — because the installed session's append path
		// (`_appendCustomMessage`) does NOT dispatch extension message_end
		// handlers (it uses the listener emit, not _emitExtensionEvent) — the
		// extension retires the batch itself right after the synchronous
		// append, so the outcome cannot masquerade as pending forever or be
		// recovered into a duplicate later.
		const harness = await setupIntegration([
			{ stopReason: "toolUse", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "post-abort" } }] },
			{ stopReason: "toolUse", toolCalls: [{ id: "c2", name: "read", arguments: {} }] },
			// Consumed by the aborted round-3 request (signal overrides script).
			{ stopReason: "stop" },
		])
		registry = harness.state.registry
		const origEmit = harness.pi.emit.bind(harness.pi)
		let aborted = false
		harness.pi.emit = async (event: string, payload: unknown, context?: unknown) => {
			const p = payload as { toolName?: string }
			if (event === "tool_execution_start" && p?.toolName === "read" && !aborted) {
				aborted = true
				// The user aborts mid-execution; the process keeps running.
				await new Promise((resolve) => setTimeout(resolve, 20))
				harness.agent.abort()
			}
			return origEmit(event, payload, context as ExtensionContext)
		}

		await harness.agent.prompt([{ role: "user", content: [{ type: "text", text: "train" }], timestamp: Date.now() }])
		expect(harness.agent.state.isStreaming).toBe(false)
		expect(harness.requests.length).toBe(3)

		// The unattended exit lands while the session is idle and terminated.
		harness.ops.emitMatching("post-abort", `${MARKER}\n`)
		await harness.ops.exitMatching("post-abort", 0)
		await new Promise((resolve) => setTimeout(resolve, 50))

		// No inference restart: no new provider request was made.
		expect(harness.requests.length).toBe(3)
		// The payload was appended to the conversation exactly once…
		const appended = harness.agent.state.messages.filter(
			(m) => (m as { role?: string }).role === "custom" && JSON.stringify(m).includes(MARKER),
		)
		expect(appended).toHaveLength(1)
		// …and NO message_end ever fired for it (the append path does not
		// dispatch extension handlers) — the batch retired on the append.
		expect(harness.exitMessageEnds).toHaveLength(0)
		expect(harness.state.delivery.hasPending()).toBe(false)
	})
})
