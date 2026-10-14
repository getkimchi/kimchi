/**
 * Real-AgentSession integration for the retry-aware continuation-nudge
 * recovery (the "accepted pre-settlement limitation" from the
 * guard-nudge-done investigation).
 *
 * Unlike the manual event-firing unit tests, this file drives a REAL
 * `AgentSession` from the installed SDK with the real prompt-enrichment
 * extension bound as an inline extension, a faux provider model, and a
 * companion extension that queues unrelated followUps through the exact
 * upstream mechanism (`agent_end` handler → `agent.followUp()` →
 * `_handlePostAgentRun` → `agent.continue()`). The pre-settlement test disables
 * retries so its provider error is terminal. The cancellation test enables
 * retries and aborts the SDK's real backoff sleep. What is proven end-to-end:
 *
 *  - the drift turn arms the nudge through the real turn_end handler;
 *  - the terminal error attempt keeps the recovery armed (retry-aware Fix 1);
 *  - the companion's followUp continuation runs BEFORE settlement and its
 *    text-only response is blanked and marked withheld (the accepted
 *    limitation), heals at its own turn_end, and draws no second/empty-turn
 *    nudge;
 *  - exactly one continuation nudge is ever injected (errors consume no
 *    budget);
 *  - a later extension-triggered response (second followUp, no intervening
 *    user input or tool call) streams unblanked once the recovery ended.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai"
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	type ExtensionAPI,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as ConfigModule from "../../config.js"
import type * as StartupContextModule from "../../startup-context.js"

/** Shared mutable state for the hoisted config mock: the temp harness dir. */
const configState = vi.hoisted(() => ({ agentConfigDir: "" }))

// prompt-enrichment reads the developer's real kimchi config at
// session_start (apiKey gates an orchestrator-remap write, agentConfigDir
// feeds model-role validation). Point both at the isolated temp harness.
vi.mock("../../config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof ConfigModule>()
	return {
		...actual,
		loadConfig: () =>
			({ apiKey: "", agentConfigDir: configState.agentConfigDir }) as ReturnType<typeof actual.loadConfig>,
	}
})

vi.mock("../../startup-context.js", async (importOriginal) => {
	const actual = await importOriginal<typeof StartupContextModule>()
	return { ...actual, getAvailableModels: () => [] }
})

import { ASSISTANT_OUTPUT_WITHHELD } from "../orchestration/continuation-nudge.js"
import promptEnrichmentExtension from "./prompt-enrichment.js"

const CONTINUATION_NUDGE_PHRASE = "You ended your turn without calling a tool"
const SECOND_NUDGE_PHRASE = "MUST call the required tool immediately"
const EMPTY_TURN_NUDGE_PHRASE = "If you have finished, please summarize the result for the user"

/**
 * The "another extension" from the accepted-limitation scenario. Queues one
 * unrelated followUp when the armed nudge round dies on a terminal error
 * (running before settlement through the upstream continue-while-queued
 * loop), and one more followUp once that continuation has answered — a later
 * extension-triggered turn with no intervening user input or tool call.
 * `pi.sendMessage` is fire-and-forget at the extension layer; the queued
 * followUps are drained by the agent-session loop inside the awaited
 * `agent_end` emission, so the rounds they trigger are fully awaited there.
 */
function unrelatedFollowUpExtension(pi: ExtensionAPI): void {
	let queuedAtError = false
	let queuedAtRecovery = false
	pi.on("agent_end", (event) => {
		const last = [...event.messages].reverse().find((m) => m.role === "assistant")
		const endedOnError = last !== undefined && "stopReason" in last && last.stopReason === "error"
		if (!queuedAtError && endedOnError) {
			queuedAtError = true
			pi.sendMessage(
				{
					customType: "integration-unrelated-followup",
					content: "The background watcher finished.",
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			)
			return
		}
		if (queuedAtError && !queuedAtRecovery && !endedOnError) {
			queuedAtRecovery = true
			pi.sendMessage(
				{
					customType: "integration-post-recovery-followup",
					content: "The watcher finished again.",
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			)
		}
	})
}

/** A no-op custom tool: executing it once arms the session tool latch so the
 *  continuation nudge is not suppressed by the fresh-session guard. */
const probeTool = defineTool({
	name: "probe",
	label: "Probe",
	description: "Records a probe tool call.",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
})

describe("continuation nudge recovery through a real AgentSession", () => {
	let workDir: string

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "kimchi-nudge-session-"))
		const harnessDir = join(workDir, "harness")
		mkdirSync(harnessDir, { recursive: true })
		configState.agentConfigDir = harnessDir
		// Retries disabled: the scripted provider error is terminal, so the
		// companion's agent_end followUp runs before settlement — the exact
		// window the accepted limitation describes. The api_key credential
		// satisfies the session's request-auth validation for the faux provider.
		writeFileSync(join(harnessDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }), "utf-8")
		writeFileSync(join(harnessDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "test" } }), "utf-8")
	})

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true })
	})

	async function startSession(faux: ReturnType<typeof fauxProvider>, includeFollowUps = false) {
		const resourceLoader = new DefaultResourceLoader({
			cwd: workDir,
			agentDir: join(workDir, "harness"),
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [
				...(includeFollowUps ? [{ name: "unrelated-followup", factory: unrelatedFollowUpExtension }] : []),
				(pi: ExtensionAPI) => {
					promptEnrichmentExtension(() => [])(pi)
				},
			],
		})
		// createAgentSession only loads a loader it constructed itself — a
		// caller-supplied loader must be loaded before it is handed over.
		await resourceLoader.reload()

		// Register the faux provider with a runtime that reads the isolated
		// harness auth.json, so the session's request-auth validation passes.
		const modelRuntime = await ModelRuntime.create({
			authPath: join(workDir, "harness", "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		})
		modelRuntime.registerNativeProvider(faux.provider)

		return createAgentSession({
			cwd: workDir,
			agentDir: join(workDir, "harness"),
			model: faux.getModel(),
			modelRuntime,
			customTools: [probeTool],
			resourceLoader,
		})
	}

	it("blanks the pre-settlement followUp response once, then heals", async () => {
		// Every provider request's message list, recorded by the faux response
		// factories — the same evidence channel the e2e suites use.
		const requestMessages: string[] = []
		const record =
			(step: AssistantMessage): FauxResponseStep =>
			(context) => {
				requestMessages.push(JSON.stringify(context.messages))
				return step
			}

		const faux = fauxProvider({
			models: [{ id: "drift-model", contextWindow: 200_000, maxTokens: 8192 }],
		})
		// Prompt 1: a tool cycle (latch) + a visible answer.
		// Prompt 2: drift → nudge #1 → terminal error attempt → companion's
		// followUp → blanked continuation → second followUp → visible response.
		faux.setResponses([
			record(fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" })),
			record(fauxAssistantMessage("The probe returned ok.")),
			record(fauxAssistantMessage("I will delegate the implementation to a builder agent next.")),
			record(
				fauxAssistantMessage("Partial answer before the failure.", {
					stopReason: "error",
					errorMessage: "Invalid request: non-retryable input",
				}),
			),
			record(fauxAssistantMessage("The background watcher finished.")),
			record(fauxAssistantMessage("The watcher finished again. Let me know if you want the full log.")),
		])

		const { session } = await startSession(faux, true)

		// Streamed text deltas per assistant turn, in order — the channel the
		// ACP surface forwards as agent_message_chunk. Subscribers run after
		// extension handlers, so a blanked delta proves the pending blanking
		// ran on the real stream.
		const deltaGroups: string[][] = []
		let settledCount = 0
		session.subscribe((event) => {
			if (event.type === "agent_settled") settledCount++
			if (event.type === "message_start" && event.message.role === "assistant") {
				deltaGroups.push([])
			}
			if (event.type === "message_update" && event.message.role === "assistant") {
				const ame = event.assistantMessageEvent
				if (ame.type === "text_delta") {
					deltaGroups[deltaGroups.length - 1]?.push(ame.delta)
				}
			}
		})

		await session.prompt("run the probe")
		await session.prompt("continue with the implementation")

		// --- Nudge accounting: exactly one nudge, ever. --------------------
		// stripStaleNudges removes an acted-on nudge from later request
		// contexts, so the phrase appears in exactly one request: the error
		// attempt that answered it.
		const joinedRequests = requestMessages.join("\n")
		expect(joinedRequests).toContain(CONTINUATION_NUDGE_PHRASE)
		expect(joinedRequests).not.toContain(SECOND_NUDGE_PHRASE)
		expect(joinedRequests).not.toContain(EMPTY_TURN_NUDGE_PHRASE)
		expect(joinedRequests.split(CONTINUATION_NUDGE_PHRASE).length - 1).toBe(1)

		// --- The pre-settlement continuation was blanked + marked. ---------
		const assistants = session.state.messages.filter((m) => m.role === "assistant")
		const erroredIndex = assistants.findIndex((m) => "stopReason" in m && m.stopReason === "error")
		expect(erroredIndex).toBeGreaterThanOrEqual(0)
		const continuation = assistants[erroredIndex + 1]
		expect(continuation).toBeDefined()
		const continuationText = (continuation.content as Array<{ type: string; text?: string }>)
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("")
		expect(continuationText).toBe("")
		expect((continuation as unknown as Record<symbol, unknown>)[ASSISTANT_OUTPUT_WITHHELD]).toBe(true)
		// The streamed deltas for that response were blanked too (ACP-side).
		expect((deltaGroups[erroredIndex + 1] ?? []).join("")).toBe("")

		// --- The recovery healed: the later extension-triggered response
		// (second followUp, no intervening user input or tool call) streamed
		// unblanked and was not itself nudged. ------------------------------
		const postRecovery = assistants[assistants.length - 1]
		const postText = (postRecovery.content as Array<{ type: string; text?: string }>)
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("")
		expect(postText).toContain("The watcher finished again.")
		expect((deltaGroups[assistants.length - 1] ?? []).join("")).toContain("The watcher finished again.")
		// Two settled runs total: prompt 1, and prompt 2's single agent run
		// (drift + nudge round + error + both followUp continuations drained
		// by the upstream continue-while-queued loop before settlement).
		expect(settledCount).toBe(2)
	})
	it("cancels a real retry backoff and leaves later extension-triggered output visible", async () => {
		writeFileSync(
			join(workDir, "harness", "settings.json"),
			JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } }),
			"utf-8",
		)
		const faux = fauxProvider({
			models: [{ id: "drift-model", contextWindow: 200_000, maxTokens: 8192 }],
		})
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("The probe returned ok."),
			fauxAssistantMessage("I will delegate the implementation next."),
			fauxAssistantMessage("Partial recovery response.", {
				stopReason: "error",
				errorMessage: "500 Internal Server Error",
			}),
			fauxAssistantMessage("The watcher finished. Let me know if you want the full log."),
		])
		const { session } = await startSession(faux)
		const stopReasons: string[] = []
		const retryResults: string[] = []
		let settledCount = 0
		let cancelledWhileRetrying = false
		let streamed = ""
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				// The SDK installs its abort controller immediately after emitting
				// this event. Cancel on the next microtask, inside the real sleep.
				queueMicrotask(() => {
					cancelledWhileRetrying = session.isRetrying
					session.abortRetry()
				})
			}
			if (event.type === "auto_retry_end") retryResults.push(event.finalError ?? "")
			if (event.type === "agent_settled") settledCount++
			if (event.type === "turn_end" && event.message.role === "assistant") {
				stopReasons.push(event.message.stopReason)
			}
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				streamed += event.assistantMessageEvent.delta
			}
		})
		try {
			await session.prompt("run the probe")
			await session.prompt("continue with the implementation")
			expect(cancelledWhileRetrying).toBe(true)
			expect(retryResults).toEqual(["Retry cancelled"])
			expect(stopReasons).toEqual(["toolUse", "stop", "stop", "error"])
			expect(settledCount).toBe(2)
			expect(streamed).not.toContain("Partial recovery response.")

			// No user input or tool call resets pending between cancellation and
			// this unrelated response: settlement alone must have cleared it.
			streamed = ""
			await session.sendCustomMessage(
				{ customType: "integration-after-cancel", content: "The watcher finished.", display: false },
				{ triggerTurn: true },
			)
			expect(streamed).toContain("The watcher finished.")
			expect(settledCount).toBe(3)
			expect(stopReasons).toEqual(["toolUse", "stop", "stop", "error", "stop"])
		} finally {
			session.dispose()
		}
	})
})
