import { existsSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForRequest, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const MAIN_MODEL = {
	slug: "basic",
	displayName: "Fake Basic",
	provider: "ai-enabler",
	contextWindow: 200_000,
	maxTokens: 8192,
}
const CLASSIFIER_MODEL = {
	slug: "deepseek-v4-flash-0731",
	displayName: "DeepSeek V4 Flash",
	provider: "ai-enabler",
	contextWindow: 200_000,
	maxTokens: 8192,
}
const MODELS = [MAIN_MODEL, CLASSIFIER_MODEL]
const ALLOW_PROMPT = "Allow the assistant to run this?"
const WRITE_ARGS = JSON.stringify({ path: "output.txt", content: "hello world" })

function agentCall(background = false) {
	return {
		function: {
			name: "Agent",
			arguments: JSON.stringify({
				prompt: "Use the write tool to create output.txt containing: hello world",
				description: "write output file",
				subagent_type: "General-Purpose",
				run_in_background: background,
			}),
		},
	}
}

function isClassifierRequest(body: unknown): boolean {
	if (!body || typeof body !== "object") return false
	const messages = (body as { messages?: unknown }).messages
	if (!Array.isArray(messages) || messages.length === 0) return false
	const first = messages[0] as { role?: unknown; content?: unknown }
	return (
		first?.role === "system" && typeof first.content === "string" && first.content.startsWith("You are a security gate")
	)
}

function isSubagentRequest(request: { url: string; body: unknown }): boolean {
	if (!request.url.endsWith("/chat/completions")) return false
	const messages = (request.body as { messages?: Array<{ role: string; content: unknown }> } | null)?.messages
	return (
		Array.isArray(messages) &&
		messages.some(
			(message) =>
				message.role === "system" &&
				(typeof message.content === "string" ? message.content : JSON.stringify(message.content)).includes(
					"You are a kimchi coding agent sub-agent.",
				),
		)
	)
}

test("parent deny rule blocks a subagent write and the parent continues", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-parent-deny-rule",
			providerId: "kimchi-dev",
			models: MODELS,
			extraArgs: ["--deny-tool", "write"],
			responses: [
				{ stream: ["Delegating."], toolCalls: [agentCall()] },
				{
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
					forSubagent: true,
				},
				{ stream: ["CHILD-DENY-WRITE-DONE"], forSubagent: true },
				{ stream: ["PARENT-DENY-WRITE-DONE"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Have a subagent create output.txt")
			await waitForText(terminal, "PARENT-DENY-WRITE-DONE", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(false)
			trace.step("deny blocked the child write and the parent continued")
		},
	)
})

test("control without the deny rule lets the same subagent write", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-parent-deny-control",
			providerId: "kimchi-dev",
			models: MODELS,
			responses: [
				{ stream: ["Delegating."], toolCalls: [agentCall()] },
				{
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
					forSubagent: true,
				},
				{ stream: ["CHILD-CONTROL-WRITE-DONE"], forSubagent: true },
				{ stream: ["PARENT-CONTROL-WRITE-DONE"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Have a subagent create output.txt")
			await waitForText(terminal, "PARENT-CONTROL-WRITE-DONE", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(true)
			trace.step("control wrote the same file without the deny rule")
		},
	)
})

test("auto mode asks the parent when the classifier is not safe; approval runs the write", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-auto-classifier-deny",
			providerId: "kimchi-dev",
			models: MODELS,
			extraArgs: ["--auto"],
			responses: [
				{ stream: ["Delegating."], toolCalls: [agentCall()] },
				{
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
					forSubagent: true,
				},
				{
					match: (request) => isClassifierRequest(request.body),
					stream: [
						'{"verdict":"requires-confirmation","reason":"The worker cannot ask for approval","riskScore":"high"}',
					],
				},
				{ stream: ["CHILD-AUTO-DENY-DONE"], forSubagent: true },
				{ stream: ["PARENT-AUTO-DENY-DONE"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Have a subagent create output.txt")
			await waitForText(terminal, "Subagent General-Purpose — write output file wants to run:", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			const promptView = fullText(terminal)
			trace.step("escalated non-safe prompt visible in the parent")
			terminal.keyDown() // deny is first by default; choose Yes — just this call
			terminal.submit("")
			await waitForText(terminal, "PARENT-AUTO-DENY-DONE", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(true)
			expect(promptView).toContain(ALLOW_PROMPT)
			expect(fixture.fake.requests.filter((request) => isClassifierRequest(request.body)).length).toBeGreaterThan(0)
			trace.step("parent approval ran the child write")
		},
	)
})

test("default mode writes when the classifier is safe and shows no worker prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-default-classifier-safe",
			providerId: "kimchi-dev",
			models: MODELS,
			env: { KIMCHI_PERMISSIONS: "default" },
			responses: [
				{ stream: ["Delegating."], toolCalls: [agentCall()] },
				{
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
					forSubagent: true,
				},
				{
					match: (request) => isClassifierRequest(request.body),
					stream: ['{"verdict":"safe","reason":"Routine requested file write","riskScore":"low"}'],
				},
				{ stream: ["CHILD-DEFAULT-SAFE-DONE"], forSubagent: true },
				{ stream: ["PARENT-DEFAULT-SAFE-DONE"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Have a subagent create output.txt")
			await waitForText(terminal, "PARENT-DEFAULT-SAFE-DONE", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(true)
			expect(fullText(terminal)).not.toContain(ALLOW_PROMPT)
			trace.step("safe classifier verdict allowed the file without a prompt")
		},
	)
})

test("a running background subagent follows the parent into plan mode", async ({ terminal }) => {
	let releaseChild: (() => void) | undefined
	const childHold = new Promise<void>((resolve) => {
		releaseChild = resolve
	})
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-live-plan-mode",
			providerId: "kimchi-dev",
			models: MODELS,
			responses: [
				{ stream: ["Delegating in background."], toolCalls: [agentCall(true)] },
				{ stream: ["BACKGROUND-AGENT-STARTED"] },
				{
					forSubagent: true,
					holdUntil: childHold,
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
				},
				{ stream: ["WORKER-BLOCKED-BY-PLAN"], forSubagent: true },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start a background subagent to create output.txt")
			await waitForText(terminal, "BACKGROUND-AGENT-STARTED", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForRequest(fixture.fake.requests, isSubagentRequest, "the held background subagent request")
			terminal.submit("/permissions mode plan")
			await waitForText(terminal, /plan(?: → shift\+tab)? · basic\b/, { full: false })
			trace.step("parent entered plan before releasing the child's write")

			if (!releaseChild) throw new Error("child release was not initialized")
			releaseChild()
			await waitForText(terminal, "WORKER-BLOCKED-BY-PLAN", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(false)
			trace.step("next worker call was blocked by the live parent mode")
		},
	)
})
