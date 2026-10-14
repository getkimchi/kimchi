/**
 * SDK contract tests: background-bash exit delivery through the REAL
 * `AgentSession`.
 *
 * Unlike delivery-integration.test.ts (which hand-rolls the AgentSession's
 * event translation with a fake dispatch), these tests run the actual
 * `createAgentSession` + `DefaultResourceLoader` + inline extension
 * factories — the real `_emitExtensionEvent` translation (including the
 * message_end replacement hook applied in place before the loop pushes a
 * message into the run context), the real steering/follow-up queues, the
 * real prompt/abort/steer surface, and real session persistence.
 *
 * What is faked: the model runtime (a scripted `streamSimple` that records
 * every provider-visible request context and serves scripted assistant
 * responses, honoring the abort signal) and the process backend
 * (`FakeOps`, injected through the extension factory's session state).
 *
 * Verified per the review contract, from provider request history AND
 * persisted session history (session.exportToJsonl), not extension-event
 * mocks:
 *  1. custom-message acknowledgement — an unattended exit during tool work
 *     reaches the NEXT provider request exactly once and retires;
 *  2. superseded-message replacement — after an abort releases a queued
 *     notification and a control call delivers the outcome first, the late
 *     automatic message is REPLACED with a suppression note in place;
 *  3. recovery after cancellation — abort + dropped steering leaves the
 *     outcome recoverable; an explicit inspection delivers it exactly once;
 *  4. idle append after cancellation — an exit is persisted and retired
 *     without restarting inference, then appears once in the resumed context.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import {
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { afterAll, describe, expect, it } from "vitest"
import { createFakeOps, type FakeOps } from "./__mocks__/fake-bash-ops.js"
import { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
import bashControlExtension from "./bash-control-extension.js"
import { createProcessRegistry } from "./process-registry.js"
import { createReviewCoordinator } from "./review-coordinator.js"
import { type BashSessionState, getSessionState, setSessionState } from "./session-registry.js"
import { createTerminalDelivery } from "./terminal-delivery.js"

/** Unique terminal marker emitted as process OUTPUT at exit time. */
const MARKER = "CONTRACT-MARKER-4d2c"

/** One scripted assistant response. */
interface ScriptedResponse {
	stopReason: "toolUse" | "stop"
	text?: string
	textDelayMs?: number
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
}

const fakeModel = {
	id: "contract-model",
	name: "Contract Model",
	api: "openai-completions",
	provider: "contract",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
}

interface RecordedRequest {
	/** Serialized provider-visible context (the request the model would see). */
	messages: unknown[]
}

/**
 * Minimal scripted ModelRuntime: records every provider-visible request
 * context and serves scripted assistant responses through streamSimple.
 * Aborts surface as stopReason "aborted", exactly like a real provider
 * stream cut by the agent's abort signal.
 */
function makeScriptedRuntime(script: ScriptedResponse[]): {
	runtime: ModelRuntime
	requests: RecordedRequest[]
} {
	const requests: RecordedRequest[] = []
	let round = 0
	const runtime = {
		getAuth: async () => ({ auth: { apiKey: "fake" }, model: fakeModel }),
		hasConfiguredAuth: () => true,
		isUsingOAuth: () => false,
		checkAuth: async () => ({ ok: true }),
		getAvailableSnapshot: () => [fakeModel],
		getModel: () => fakeModel,
		streamSimple: (_model: unknown, context: { messages: unknown[] }, options: { signal?: AbortSignal }) => {
			round += 1
			requests.push({ messages: context.messages })
			const scripted = script.shift()
			if (!scripted) throw new Error(`scripted runtime has no response for round ${round}`)
			const buildMessage = () => ({
				role: "assistant",
				provider: "contract",
				model: fakeModel.id,
				api: fakeModel.api,
				timestamp: Date.now(),
				stopReason: options?.signal?.aborted ? "aborted" : scripted.stopReason,
				content: (scripted.toolCalls ?? []).map((call) => ({
					type: "toolCall",
					id: call.id,
					name: call.name,
					arguments: call.arguments,
				})),
			})
			return {
				async *[Symbol.asyncIterator]() {
					if (scripted.text !== undefined) {
						const chunks = scripted.text.match(/.{1,24}/g) ?? []
						for (const chunk of chunks) {
							if (options?.signal?.aborted) break
							if (scripted.textDelayMs) await delay(scripted.textDelayMs)
							yield { type: "message_delta" as const, delta: { type: "text" as const, text: chunk } }
						}
					}
					// Always end with a done event, exactly like a real provider
					// stream (the agent assembles the final message from it).
					yield { type: "done" as const, message: buildMessage() }
				},
				result: async () => buildMessage(),
			}
		},
	} as unknown as ModelRuntime
	return { runtime, requests }
}

/** Install the session-scoped background-bash state + fake-ops bash tool. */
function backgroundBashFactory(ops: FakeOps) {
	return (pi: ExtensionAPI): void => {
		pi.on("session_start", (_event, sessionCtx) => {
			const registry = createProcessRegistry()
			const coordinator = createReviewCoordinator({ registry })
			const state: BashSessionState = {
				registry,
				coordinator,
				delivery: createTerminalDelivery(),
				limitSeconds: 600,
				cwd: sessionCtx.cwd,
			}
			setSessionState(sessionCtx.sessionManager.getSessionId(), state)
			pi.registerTool(createBackgroundBashToolDefinition(sessionCtx.cwd, { state, operations: ops }) as ToolDefinition)
		})
		pi.on("session_shutdown", async (_event, ctx) => {
			const state = getSessionState(ctx.sessionManager.getSessionId())
			if (state) {
				setSessionState(ctx.sessionManager.getSessionId(), undefined)
				state.coordinator.dispose()
				await state.registry.shutdown()
			}
		})
	}
}

interface ContractHarness {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"]
	requests: RecordedRequest[]
	ops: FakeOps
	workDir: string
}

const tmpDirs: string[] = []

async function setupSession(script: ScriptedResponse[]): Promise<ContractHarness> {
	const workDir = mkdtempSync(join(tmpdir(), "bash-contract-"))
	tmpDirs.push(workDir)
	const ops = createFakeOps()
	const loader = new DefaultResourceLoader({
		cwd: workDir,
		agentDir: workDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => "You are a contract-test agent.",
		appendSystemPromptOverride: () => [],
		extensionFactories: [backgroundBashFactory(ops), bashControlExtension],
	})
	await loader.reload()
	const { runtime, requests } = makeScriptedRuntime(script)
	// A custom "independent work" tool: exits the named background process
	// mid-execution (emitting the marker as output) and keeps the turn busy
	// long enough for the exit notification to flush during it.
	const independentTool: ToolDefinition = {
		name: "independent",
		label: "independent",
		description: "Independent work that also ends the background command",
		parameters: { type: "object" as const, properties: {}, additionalProperties: false },
		execute: async () => {
			ops.emitMatching("train", `${MARKER}\n`)
			await ops.exitMatching("train", 0)
			await delay(150)
			return { content: [{ type: "text", text: "independent work done" }], details: {} }
		},
	}
	const { session } = await createAgentSession({
		cwd: workDir,
		agentDir: workDir,
		sessionManager: SessionManager.inMemory(workDir),
		settingsManager: SettingsManager.create(workDir, workDir),
		model: fakeModel as unknown as Parameters<typeof createAgentSession>[0] extends infer O
			? O extends { model?: infer M }
				? M
				: never
			: never,
		modelRuntime: runtime,
		resourceLoader: loader,
		tools: ["read", "bash", "bash_control", "independent"],
		customTools: [independentTool],
	})
	await session.bindExtensions({
		onError: (err) => {
			throw new Error(`extension failed in contract session: ${err.error ?? err.extensionPath}`)
		},
	})
	return { session, requests, ops, workDir }
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

/** Count occurrences of a needle in one provider-visible request. */
const inRequest = (request: RecordedRequest, needle: string): number =>
	JSON.stringify(request.messages).split(needle).length - 1

/** Export the session branch and return its JSONL text. */
async function exportJsonl(harness: ContractHarness): Promise<string> {
	const path = harness.session.exportToJsonl(join(harness.workDir, "session-export.jsonl"))
	const { readFileSync } = await import("node:fs")
	return readFileSync(path, "utf8")
}

describe("background bash delivery contract (real AgentSession)", () => {
	it("acknowledges an unattended exit at the next request boundary and retires it", async () => {
		const harness = await setupSession([
			{ stopReason: "toolUse", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "train" } }] },
			{ stopReason: "toolUse", toolCalls: [{ id: "c2", name: "independent", arguments: {} }] },
			{ stopReason: "stop", text: "The background command finished; done." },
		])
		await harness.session.prompt("Run the training command and do independent work")

		// Three provider requests: spawn, independent work, final. The exit
		// happened during the independent tool; its notification was consumed
		// at the turn boundary BEFORE the final request.
		expect(harness.requests).toHaveLength(3)
		expect(inRequest(harness.requests[0] as RecordedRequest, MARKER)).toBe(0)
		expect(inRequest(harness.requests[1] as RecordedRequest, MARKER)).toBe(0)
		expect(inRequest(harness.requests[2] as RecordedRequest, MARKER)).toBe(1)

		// The conversation (agent state) carries the payload exactly once —
		// as the automatic custom message.
		const conversation = JSON.stringify(harness.session.messages)
		expect(conversation.split(MARKER).length - 1).toBe(1)

		// Persisted session history agrees: the payload appears once.
		const jsonl = await exportJsonl(harness)
		expect(jsonl.split(MARKER).length - 1).toBe(1)

		// The outcome retired: nothing pending, nothing tracked.
		const state = getSessionState(harness.session.sessionManager.getSessionId())
		expect(state?.delivery.hasPending()).toBe(false)
		expect(state?.registry.size).toBe(0)

		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
	})

	it("replaces a superseded late notification after an abort-release and a control delivery", async () => {
		// An advisory steer is queued AHEAD of the exit notification; the run
		// is aborted WITHOUT dropping the queues (a programmatic abort). The
		// abort releases the queued outcome back to `available`; the
		// recovery run consumes the advisory steer first, whose response is
		// an explicit bash_control inspection that claims and delivers the
		// outcome through its tool result — and only THEN the late automatic
		// message is consumed, superseded: replaced in place with a
		// suppression note, so the payload is never repeated.
		const harness = await setupSession([
			{ stopReason: "toolUse", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "train" } }] },
			// Round 2: a SLOW finishing attempt — the test steers and the
			// process exits mid-stream.
			{
				stopReason: "stop",
				text: "I believe the training is complete; nothing further is needed from my side.",
				textDelayMs: 300,
			},
			// Round 3 (after the steer): the explicit inspection.
			{ stopReason: "toolUse", toolCalls: [{ id: "c2", name: "bash_control", arguments: { wait: false } }] },
			{ stopReason: "stop", text: "Recovered the result; everything is resolved." },
		])
		const pending = harness.session.prompt("Run the training command, then finish the task")

		// Wait for the second request (the finishing attempt) to start, then
		// queue an advisory steer ahead of everything else.
		while (harness.requests.length < 2) await delay(20)
		await harness.session.steer("Actually, inspect the background command")

		// The background process exits mid-stream; its notification queues
		// as steering BEHIND the advisory.
		harness.ops.emitMatching("train", `${MARKER}\n`)
		await harness.ops.exitMatching("train", 0)
		while (!getSessionState(harness.session.sessionManager.getSessionId())?.delivery.hasQueuedAutomatic())
			await delay(20)

		// Abort the run programmatically (queues are NOT dropped). The real
		// AgentSession chains a continuation after the aborted run: it consumes
		// the advisory steer first (whose scripted response is the explicit
		// inspection — claiming and delivering the released outcome through its
		// tool result) and only THEN the late automatic message — superseded,
		// replaced in place with a suppression note. The prompt resolves after
		// the whole chain settles.
		await harness.session.abort()
		await pending

		// The payload reached the provider EXACTLY once — through the
		// inspection's tool result, never through the late message.
		const markerCounts = harness.requests.map((r) => inRequest(r, MARKER))
		expect(markerCounts[0]).toBe(0)
		expect(markerCounts[1]).toBe(0)
		expect(markerCounts.filter((c) => c > 0)).toHaveLength(1)
		expect(markerCounts.filter((c) => c > 0)[0]).toBe(1)
		// The conversation carries the suppression note (the replaced late
		// message), and the payload exactly once.
		const conversation = JSON.stringify(harness.session.messages)
		expect(conversation.split(MARKER).length - 1).toBe(1)
		expect(conversation).toContain("was suppressed")

		// Persisted history shows the same contract: payload once.
		const jsonl = await exportJsonl(harness)
		expect(jsonl.split(MARKER).length - 1).toBe(1)

		// Retired everywhere.
		expect(getSessionState(harness.session.sessionManager.getSessionId())?.delivery.hasPending()).toBe(false)

		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
	})

	it("recovers one outcome from a cancelled batch without duplicating it in the late notification", async () => {
		const inspectArgs = { handles: [] as string[] }
		const firstMarker = "PARTIAL-RECOVERY-FIRST"
		const secondMarker = "PARTIAL-RECOVERY-SECOND"
		const harness = await setupSession([
			{
				stopReason: "toolUse",
				toolCalls: [
					{ id: "spawn-a", name: "bash", arguments: { command: "process-a" } },
					{ id: "spawn-b", name: "bash", arguments: { command: "process-b" } },
				],
			},
			{ stopReason: "stop", text: "Waiting for the processes to finish while drafting the answer.", textDelayMs: 300 },
			{ stopReason: "toolUse", toolCalls: [{ id: "recover-a", name: "bash_control", arguments: inspectArgs }] },
			{ stopReason: "stop", text: "Both outcomes received." },
		])
		try {
			const pending = harness.session.prompt("Run two commands, then finish")
			while (harness.requests.length < 2) await delay(20)
			const state = getSessionState(harness.session.sessionManager.getSessionId())
			if (!state) throw new Error("background state missing")
			const firstHandle = state.coordinator
				.handles()
				.find((handle) => state.registry.getEntry(handle)?.commandSummary === "process-a")
			if (!firstHandle) throw new Error("first process missing")
			inspectArgs.handles.push(firstHandle)
			await harness.session.steer("Inspect only the first process")
			harness.ops.emitMatching("process-a", `${firstMarker}\n`)
			harness.ops.emitMatching("process-b", `${secondMarker}\n`)
			await harness.ops.exitMatching("process-a", 0)
			await harness.ops.exitMatching("process-b", 7)
			while (!state.delivery.hasQueuedAutomatic()) await delay(20)
			expect(
				new Set(state.delivery.pendingHandles().map((handle) => state.delivery.getPending(handle)?.deliveryId)).size,
			).toBe(1)
			await harness.session.abort()
			await pending

			const lastRequest = harness.requests.at(-1)
			if (!lastRequest) throw new Error("provider request missing")
			for (const marker of [firstMarker, secondMarker]) {
				expect(inRequest(lastRequest, marker)).toBe(1)
				expect(JSON.stringify(harness.session.messages).split(marker).length - 1).toBe(1)
				expect((await exportJsonl(harness)).split(marker).length - 1).toBe(1)
			}
			const exitNotice = harness.session.messages.find(
				(message) => message.role === "custom" && message.customType === "bash-background-exit",
			)
			expect(JSON.stringify(exitNotice)).not.toContain(firstMarker)
			expect(JSON.stringify(exitNotice)).toContain(secondMarker)
			expect(JSON.stringify(exitNotice)).toContain("exit code 7")
			expect(state.delivery.hasPending()).toBe(false)
		} finally {
			await harness.session.abort()
			await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
		}
	}, 20_000)

	it("recovers a dropped notification after cancellation through an explicit inspection", async () => {
		// Kimchi's TUI (Escape) and ACP (cancel) DROP queued steering on
		// abort. The outcome must stay pending+recoverable, never restart
		// inference by itself, and a later explicit inspection must deliver
		// it exactly once.
		const harness = await setupSession([
			{ stopReason: "toolUse", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "train" } }] },
			{ stopReason: "toolUse", toolCalls: [{ id: "c2", name: "independent", arguments: {} }] },
			// Round 3 is consumed by the aborted request (signal overrides).
			{ stopReason: "stop", text: "unused" },
			// Recovery run: explicit inspection, then settle.
			{ stopReason: "toolUse", toolCalls: [{ id: "c3", name: "bash_control", arguments: { wait: false } }] },
			{ stopReason: "stop", text: "Collected the dropped result; done." },
		])
		const pending = harness.session.prompt("Run the training command and do independent work")

		// The independent tool exits the process mid-run; the notification
		// queues while the turn is still streaming tool results.
		while (harness.requests.length < 2) await delay(20)
		while (!getSessionState(harness.session.sessionManager.getSessionId())?.delivery.hasQueuedAutomatic())
			await delay(20)

		// The user aborts; the surface drops the queued steering (mirrored
		// by clearQueue before abort).
		await harness.session.clearQueue()
		await harness.session.abort()
		await pending
		expect(harness.session.isStreaming).toBe(false)

		// The outcome survived as recoverable (available), process gone.
		const handle = getSessionState(harness.session.sessionManager.getSessionId())?.delivery.pendingHandles()[0]
		expect(handle).toBeTruthy()
		expect(
			getSessionState(harness.session.sessionManager.getSessionId())?.delivery.getPending(handle as string)?.phase,
		).toBe("available")
		expect(
			getSessionState(harness.session.sessionManager.getSessionId())?.registry.getEntry(handle as string),
		).toBeUndefined()
		expect(harness.session.isStreaming).toBe(false)

		// No provider request saw the payload yet.
		expect(harness.requests.some((r) => inRequest(r, MARKER) > 0)).toBe(false)

		// Explicit recovery: the inspection delivers it through the tool
		// result — exactly once — and the run settles.
		await harness.session.prompt("Collect the background result")

		const markerRequests = harness.requests.filter((r) => inRequest(r, MARKER) > 0)
		expect(markerRequests).toHaveLength(1)
		const conversation = JSON.stringify(harness.session.messages)
		expect(conversation.split(MARKER).length - 1).toBe(1)
		const jsonl = await exportJsonl(harness)
		expect(jsonl.split(MARKER).length - 1).toBe(1)
		expect(getSessionState(harness.session.sessionManager.getSessionId())?.delivery.hasPending()).toBe(false)

		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
	}, 20_000)

	it("appends a post-abort exit once without restarting inference and retires its delivery", async () => {
		const harness = await setupSession([
			{ stopReason: "toolUse", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "train" } }] },
			{ stopReason: "stop", text: "Still considering the background command.", textDelayMs: 1000 },
			{ stopReason: "stop", text: "The saved background result is available." },
		])
		try {
			const pending = harness.session.prompt("Start the background command and consider the result")
			await expect.poll(() => harness.requests.length, { timeout: 5000 }).toBe(2)
			await harness.session.clearQueue()
			await harness.session.abort()
			await pending
			const state = getSessionState(harness.session.sessionManager.getSessionId())
			if (!state) throw new Error("Missing session state")
			expect(state.registry.size).toBe(1)
			expect(harness.session.isStreaming).toBe(false)
			const requestsBeforeExit = harness.requests.length

			harness.ops.emitMatching("train", `${MARKER}\n`)
			await harness.ops.exitMatching("train", 0)
			await expect
				.poll(() => JSON.stringify(harness.session.messages).split(MARKER).length - 1, { timeout: 3000 })
				.toBe(1)
			expect((await exportJsonl(harness)).split(MARKER).length - 1).toBe(1)
			expect(state.delivery.hasPending()).toBe(false)
			expect(state.registry.size).toBe(0)
			await delay(150)
			expect(harness.session.isStreaming).toBe(false)
			expect(harness.requests).toHaveLength(requestsBeforeExit)

			await harness.session.prompt("Continue using the saved result")
			expect(harness.requests).toHaveLength(requestsBeforeExit + 1)
			expect(inRequest(harness.requests[requestsBeforeExit] as RecordedRequest, MARKER)).toBe(1)
			expect(JSON.stringify(harness.session.messages).split(MARKER).length - 1).toBe(1)
			expect((await exportJsonl(harness)).split(MARKER).length - 1).toBe(1)
		} finally {
			await harness.session.abort()
			await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
		}
	}, 15_000)

	it("drains a queued completion guard through the real follow-up queue, replacing the obsolete one", async () => {
		// The model ends its turn with a process running (one completion
		// reminder queues behind a user steer), the steer-driven turn stops
		// the process, and the stale reminder — consumed afterwards through
		// the real follow-up queue — is REPLACED with a suppression note:
		// the provider never sees a disposition demand.
		// The steer-driven stop call receives its handle through a mutable
		// argument object, filled once the handoff is observable.
		const stopArgs: { stop_handles: string[] } = { stop_handles: [] }
		const harness = await setupSession([
			{ stopReason: "toolUse", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "train" } }] },
			// Round 2: a SLOW finishing attempt (the test steers mid-stream).
			{
				stopReason: "stop",
				text: "I believe the work is complete; nothing further is needed from my side.",
				textDelayMs: 300,
			},
			// Round 3 (the steer response): stop the process.
			{
				stopReason: "toolUse",
				toolCalls: [{ id: "c2", name: "bash_control", arguments: stopArgs as unknown as Record<string, unknown> }],
			},
			{ stopReason: "stop", text: "The command is stopped; the task is complete." },
			{ stopReason: "stop", text: "Everything is finished." },
		])

		const pending = harness.session.prompt("Run the training command, then finish the task")
		while (harness.requests.length < 2) await delay(20)
		// Fill the stop arguments with the live handle (the handoff has
		// happened by the second request) and queue the steer.
		const handle = getSessionState(harness.session.sessionManager.getSessionId())?.coordinator.handles()[0]
		expect(handle).toBeTruthy()
		stopArgs.stop_handles = [handle as string]
		await harness.session.steer("Actually, stop the background command")

		// Let the finishing attempt end and the steer-driven stop run; the
		// run settles only after the queued reminder is drained.
		await pending

		// The stale reminder never demanded a disposition from the provider.
		const allRequests = JSON.stringify(harness.requests)
		expect(allRequests).not.toContain("Task completion requires a disposition")
		// …it was replaced at consumption with the suppression note.
		expect(allRequests).toContain("completion reminder was suppressed")
		// The stop was delivered.
		expect(allRequests).toContain("stopped on request")

		const conversation = JSON.stringify(harness.session.messages)
		expect(conversation).not.toContain("Task completion requires a disposition")
		expect(conversation).toContain("completion reminder was suppressed")

		const jsonl = await exportJsonl(harness)
		expect(jsonl).toContain("completion reminder was suppressed")
		expect(jsonl).not.toContain("Task completion requires a disposition")

		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
	}, 20_000)
})
