import { existsSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, viewText, waitForRequest, waitForText } from "./support/assertions.js"
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
const WAITING_STATUS = "its prompt opens when the input is empty"
const SUBAGENT_PROMPT_HEADER = "Subagent General-Purpose — write output file wants to run:"
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
			// The subagent prompt keeps the main session's order: Enter accepts
			// the first choice rather than using a subagent-only order.
			await new Promise((resolve) => setTimeout(resolve, 500))
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

test("a subagent approval waits for the draft instead of accepting typed keys", async ({ terminal }) => {
	let releaseChild: (() => void) | undefined
	const childHold = new Promise<void>((resolve) => {
		releaseChild = resolve
	})
	const draft = "unfinished draft with 2 and j"
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-draft-input-protection",
			providerId: "kimchi-dev",
			models: MODELS,
			extraArgs: ["--auto"],
			responses: [
				{ stream: ["Delegating in background."], toolCalls: [agentCall(true)] },
				{ stream: ["BACKGROUND-DRAFT-STARTED"] },
				{
					forSubagent: true,
					holdUntil: childHold,
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
				},
				{
					match: (request) => isClassifierRequest(request.body),
					stream: [
						'{"verdict":"requires-confirmation","reason":"The worker cannot ask for approval","riskScore":"high"}',
					],
				},
				{ stream: ["DRAFT-ANSWER-HANDLED"] },
				{ stream: ["CHILD-DRAFT-APPROVED"], forSubagent: true },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start a background subagent to create output.txt")
			await waitForText(terminal, "BACKGROUND-DRAFT-STARTED", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForRequest(fixture.fake.requests, isSubagentRequest, "the held background subagent request")
			terminal.write(draft)
			if (!releaseChild) throw new Error("child release was not initialized")
			releaseChild()
			await waitForText(terminal, "is waiting for permission", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			// The toast fades; the info line above the status line stays while
			// the prompt is held back.
			await waitForText(terminal, WAITING_STATUS, { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expect(fullText(terminal)).toContain(draft)
			expect(fullText(terminal)).not.toContain(ALLOW_PROMPT)
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(false)
			trace.step("digits and ordinary editing do not approve while a draft is present")

			// This Enter submits the editor's ordinary draft; it must not answer
			// a subagent's pending selector. The resulting quiet period protects
			// the following selector's opening keystrokes as well.
			terminal.submit("")
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(false)
			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			expect(viewText(terminal)).not.toContain(WAITING_STATUS)
			await new Promise((resolve) => setTimeout(resolve, 500))
			terminal.submit("")
			await waitForText(terminal, "CHILD-DRAFT-APPROVED", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(true)
			expect(fullText(terminal)).toContain(draft)
			trace.step("the draft survives, and deliberate first-choice approval runs the write")
		},
	)
})

test("a held subagent waits behind a questionnaire without losing it", async ({ terminal }) => {
	let releaseChild: (() => void) | undefined
	const childHold = new Promise<void>((resolve) => {
		releaseChild = resolve
	})
	const questionnaireArgs = JSON.stringify({
		header: "One question",
		questions: [
			{
				id: "color",
				type: "single",
				prompt: "Pick a color",
				options: [
					{ id: "alpha", label: "Alpha" },
					{ id: "beta", label: "Beta" },
				],
			},
		],
	})
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-questionnaire-preservation",
			providerId: "kimchi-dev",
			models: MODELS,
			extraArgs: ["--auto"],
			responses: [
				{ stream: ["Delegating in background."], toolCalls: [agentCall(true)] },
				{
					stream: ["Let me ask first."],
					toolCalls: [{ function: { name: "questionnaire", arguments: questionnaireArgs } }],
				},
				{ stream: ["PARENT-QUESTION-ANSWERED"] },
				{
					forSubagent: true,
					holdUntil: childHold,
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
				},
				{
					match: (request) => isClassifierRequest(request.body),
					stream: [
						'{"verdict":"requires-confirmation","reason":"The worker cannot ask for approval","riskScore":"high"}',
					],
				},
				{ stream: ["CHILD-QUESTION-APPROVED"], forSubagent: true },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start a background subagent to create output.txt")
			await waitForText(terminal, "Pick a color", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await waitForRequest(fixture.fake.requests, isSubagentRequest, "the held background subagent request")
			if (!releaseChild) throw new Error("child release was not initialized")
			releaseChild()
			await waitForText(terminal, "is waiting for permission", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expect(fullText(terminal)).not.toContain(ALLOW_PROMPT)
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(false)
			trace.step("the held worker waits while the questionnaire keeps focus")

			terminal.submit("")
			await waitForText(terminal, "PARENT-QUESTION-ANSWERED", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			await new Promise((resolve) => setTimeout(resolve, 500))
			terminal.submit("")
			await waitForText(terminal, "CHILD-QUESTION-APPROVED", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(true)
			trace.step("the original questionnaire completes and the worker can then be approved")
		},
	)
})

test("a questionnaire opened after the subagent prompt stays answerable", async ({ terminal }) => {
	let releaseParentQuestion: (() => void) | undefined
	const parentQuestionHold = new Promise<void>((resolve) => {
		releaseParentQuestion = resolve
	})
	const questionnaireArgs = JSON.stringify({
		header: "One question",
		questions: [
			{
				id: "color",
				type: "single",
				prompt: "Pick a color",
				options: [
					{ id: "alpha", label: "Alpha" },
					{ id: "beta", label: "Beta" },
				],
			},
		],
	})
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-questionnaire-after-prompt",
			providerId: "kimchi-dev",
			models: MODELS,
			extraArgs: ["--auto"],
			responses: [
				{ stream: ["Delegating in background."], toolCalls: [agentCall(true)] },
				{
					forSubagent: true,
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
				},
				{
					holdUntil: parentQuestionHold,
					toolCalls: [{ function: { name: "questionnaire", arguments: questionnaireArgs } }],
				},
				{
					match: (request) => isClassifierRequest(request.body),
					stream: [
						'{"verdict":"requires-confirmation","reason":"The worker cannot ask for approval","riskScore":"high"}',
					],
				},
				{ stream: ["CHILD-QUESTION-AFTER-PROMPT-APPROVED"], forSubagent: true },
				{ stream: ["PARENT-QUESTION-AFTER-PROMPT-ANSWERED"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start a background subagent to create output.txt")
			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("subagent selector is already visible")
			if (!releaseParentQuestion) throw new Error("parent question release was not initialized")
			releaseParentQuestion()
			await waitForText(terminal, "Pick a color", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await new Promise((resolve) => setTimeout(resolve, 250))
			expect(fullText(terminal)).toContain("Pick a color")
			trace.step("questionnaire remains visible after the old selector yields")

			terminal.submit("")
			await waitForText(terminal, "PARENT-QUESTION-AFTER-PROMPT-ANSWERED", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(false)
			trace.step("the foreground questionnaire is answered")

			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			await new Promise((resolve) => setTimeout(resolve, 500))
			terminal.submit("")
			await waitForText(terminal, "CHILD-QUESTION-AFTER-PROMPT-APPROVED", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(true)
			trace.step("the selector returns and its first choice approves the write")
		},
	)
})

test("the session's own prompt waits behind a visible subagent prompt; both are answered", async ({ terminal }) => {
	let releaseParentWrite: (() => void) | undefined
	const parentWriteHold = new Promise<void>((resolve) => {
		releaseParentWrite = resolve
	})
	const needsConfirmation = '{"verdict":"requires-confirmation","reason":"Needs a human decision","riskScore":"high"}'
	const waitForFile = async (name: string, workDir: string) => {
		const startedAt = Date.now()
		while (Date.now() - startedAt < STREAM_TIMEOUT_MS) {
			if (existsSync(join(workDir, name))) return
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		throw new Error(`Timed out waiting for ${name} to be written`)
	}
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-prompt-before-own-prompt",
			providerId: "kimchi-dev",
			models: MODELS,
			extraArgs: ["--auto"],
			responses: [
				{ stream: ["Delegating in background."], toolCalls: [agentCall(true)] },
				{
					forSubagent: true,
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
				},
				{
					holdUntil: parentWriteHold,
					stream: ["Writing my own file."],
					toolCalls: [
						{
							function: {
								name: "write",
								arguments: JSON.stringify({ path: "main.txt", content: "from the main agent" }),
							},
						},
					],
				},
				{ match: (request) => isClassifierRequest(request.body), stream: [needsConfirmation] },
				{ match: (request) => isClassifierRequest(request.body), stream: [needsConfirmation] },
				{ stream: ["CHILD-BEFORE-OWN-PROMPT-APPROVED"], forSubagent: true },
				{ stream: ["PARENT-OWN-WRITE-DONE"] },
				{ stream: ["PARENT-OWN-WRITE-DONE"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start a background subagent to create output.txt")
			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			expect(viewText(terminal)).toContain(SUBAGENT_PROMPT_HEADER)
			trace.step("subagent selector is visible")

			if (!releaseParentWrite) throw new Error("parent write release was not initialized")
			releaseParentWrite()
			const classifierRequests = () => fixture.fake.requests.filter((request) => isClassifierRequest(request.body))
			await waitForRequest(
				fixture.fake.requests,
				() => classifierRequests().length >= 2,
				"the classifier request for the main agent's own write",
			)
			// Longer than the opening guard and several polls of the dialog watcher:
			// the queued prompt of the session itself must not withdraw this one.
			await new Promise((resolve) => setTimeout(resolve, 600))
			expect(viewText(terminal)).toContain(SUBAGENT_PROMPT_HEADER)
			expect(existsSync(join(fixture.workDir, "main.txt"))).toBe(false)
			trace.step("the session's own prompt is queued; the subagent's stays answerable")

			terminal.submit("")
			await waitForFile("output.txt", fixture.workDir)
			trace.step("the subagent's write is approved and runs")

			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain(SUBAGENT_PROMPT_HEADER)
			expect(existsSync(join(fixture.workDir, "main.txt"))).toBe(false)
			await new Promise((resolve) => setTimeout(resolve, 300))
			terminal.submit("")
			await waitForFile("main.txt", fixture.workDir)
			await waitForText(terminal, "PARENT-OWN-WRITE-DONE", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("the session's own prompt opens next and its write runs")
		},
	)
})

test("a draft holds the subagent prompt back; the session's own prompt still opens", async ({ terminal }) => {
	let releaseChild: (() => void) | undefined
	const childHold = new Promise<void>((resolve) => {
		releaseChild = resolve
	})
	let releaseParentWrite: (() => void) | undefined
	const parentWriteHold = new Promise<void>((resolve) => {
		releaseParentWrite = resolve
	})
	const draft = "unfinished draft"
	const needsConfirmation = '{"verdict":"requires-confirmation","reason":"Needs a human decision","riskScore":"high"}'
	const waitForFile = async (name: string, workDir: string) => {
		const startedAt = Date.now()
		while (Date.now() - startedAt < STREAM_TIMEOUT_MS) {
			if (existsSync(join(workDir, name))) return
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		throw new Error(`Timed out waiting for ${name} to be written`)
	}
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-held-back-own-prompt-opens",
			providerId: "kimchi-dev",
			models: MODELS,
			extraArgs: ["--auto"],
			responses: [
				{ stream: ["Delegating in background."], toolCalls: [agentCall(true)] },
				{
					forSubagent: true,
					holdUntil: childHold,
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
				},
				{
					holdUntil: parentWriteHold,
					stream: ["Writing my own file."],
					toolCalls: [
						{
							function: {
								name: "write",
								arguments: JSON.stringify({ path: "main.txt", content: "from the main agent" }),
							},
						},
					],
				},
				{ match: (request) => isClassifierRequest(request.body), stream: [needsConfirmation] },
				{ match: (request) => isClassifierRequest(request.body), stream: [needsConfirmation] },
				{ stream: ["CHILD-HELD-BACK-APPROVED"], forSubagent: true },
				{ stream: ["PARENT-OWN-WRITE-DONE"] },
				{ stream: ["PARENT-OWN-WRITE-DONE"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start a background subagent to create output.txt")
			await waitForRequest(fixture.fake.requests, isSubagentRequest, "the held background subagent request")
			terminal.write(draft)
			if (!releaseChild) throw new Error("child release was not initialized")
			releaseChild()
			await waitForText(terminal, WAITING_STATUS, { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain(ALLOW_PROMPT)
			trace.step("the draft holds the subagent's prompt back")

			if (!releaseParentWrite) throw new Error("parent write release was not initialized")
			releaseParentWrite()
			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain(SUBAGENT_PROMPT_HEADER)
			expect(viewText(terminal)).toContain("main.txt")
			trace.step("the session's own prompt opens although a subagent request is held back")

			await new Promise((resolve) => setTimeout(resolve, 300))
			terminal.submit("")
			await waitForFile("main.txt", fixture.workDir)
			await waitForText(terminal, "PARENT-OWN-WRITE-DONE", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(false)
			expect(viewText(terminal)).toContain(draft)
			trace.step("the session's own write runs; the draft and the held-back request are untouched")

			terminal.keyBackspace(draft.length)
			await waitForText(terminal, SUBAGENT_PROMPT_HEADER, { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain(WAITING_STATUS)
			// Longer than the opening guard that ignores keys already on their way.
			await new Promise((resolve) => setTimeout(resolve, 600))
			terminal.submit("")
			await waitForFile("output.txt", fixture.workDir)
			await waitForText(terminal, "CHILD-HELD-BACK-APPROVED", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("with the input empty again the subagent's prompt opens and its write runs")
		},
	)
})
