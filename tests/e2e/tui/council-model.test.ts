import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { expect, test } from "@microsoft/tui-test"
import { fullText, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { type KimchiFixture, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PHYSICAL_MODEL_SLUG = "private-physical-model"
const PHYSICAL_MODEL_REF = `fake/${PHYSICAL_MODEL_SLUG}`
const PHYSICAL_MODEL_DISPLAY = "PRIVATE_PHYSICAL_MODEL_CANARY"
const PRIVATE_REVIEW_CANARY = "PRIVATE_REVIEW_CANARY_7f40"
const PRIVATE_REASONING_CANARY = "PRIVATE_REASONING_CANARY_94ad"
const FERMENT_NOW = "2026-01-01T00:00:00.000Z"
const COUNCIL_CHANGE_OBJECTIVE = "Create council-change.txt and give me a short verified answer"
const COUNCIL_CHANGE_CONTENT = Array.from({ length: 12 }, (_, index) => `changed ${index}\n`).join("")
const PRIVATE_MARKERS = [
	PHYSICAL_MODEL_REF,
	PHYSICAL_MODEL_SLUG,
	PHYSICAL_MODEL_DISPLAY,
	PRIVATE_REVIEW_CANARY,
	PRIVATE_REASONING_CANARY,
]

const councilEnv = {
	KIMCHI_COUNCIL_LEAD_MODEL: PHYSICAL_MODEL_REF,
	KIMCHI_COUNCIL_PANEL_MODELS: [PHYSICAL_MODEL_REF, PHYSICAL_MODEL_REF, PHYSICAL_MODEL_REF].join(","),
	KIMCHI_COUNCIL_JUDGE_MODEL: PHYSICAL_MODEL_REF,
}

const privateModel = {
	slug: PHYSICAL_MODEL_SLUG,
	displayName: PHYSICAL_MODEL_DISPLAY,
	contextWindow: 1_000_000,
	maxTokens: 8_192,
}

function physicalChatRequests(fixture: KimchiFixture) {
	return fixture.fake.requests.filter(
		(request) =>
			request.url.startsWith("/openai/v1/chat/completions") &&
			request.body !== null &&
			typeof request.body === "object" &&
			!Array.isArray(request.body) &&
			(request.body as { model?: unknown }).model === PHYSICAL_MODEL_SLUG,
	)
}

function lastUserText(request: ReturnType<typeof physicalChatRequests>[number] | undefined): string {
	const body = request?.body as { messages?: Array<{ role?: string; content?: unknown }> } | undefined
	const content = [...(body?.messages ?? [])].reverse().find((message) => message.role === "user")?.content
	return typeof content === "string" ? content : ""
}

function expectPrivateTextHidden(terminal: import("@microsoft/tui-test").Terminal): void {
	const rendered = `${viewText(terminal)}\n${fullText(terminal)}`
	for (const marker of PRIVATE_MARKERS) expect(rendered).not.toContain(marker)
}

async function expectPrivateTextStaysHidden(
	terminal: import("@microsoft/tui-test").Terminal,
	durationMs: number,
): Promise<void> {
	const deadline = Date.now() + durationMs
	do {
		expectPrivateTextHidden(terminal)
		await sleep(25)
	} while (Date.now() < deadline)
}

function seedPausedFerment(workDir: string, fermentId: string, phaseId: string) {
	const resolvedWorkDir = realpathSync(workDir)
	const fermentsDir = join(resolvedWorkDir, ".kimchi", "ferments")
	mkdirSync(fermentsDir, { recursive: true })
	writeFileSync(
		join(fermentsDir, `${fermentId}.json`),
		`${JSON.stringify(
			{
				id: fermentId,
				name: "Council Tool Test",
				status: "paused",
				worktree: { path: resolvedWorkDir },
				scoping: {},
				activePhaseId: phaseId,
				phases: [
					{
						id: phaseId,
						index: 1,
						name: "Implementation",
						goal: "Exercise a Council tool call.",
						status: "active",
						startedAt: FERMENT_NOW,
						steps: [],
					},
				],
				decisions: [],
				memories: [],
				createdAt: FERMENT_NOW,
				updatedAt: FERMENT_NOW,
			},
			null,
			2,
		)}\n`,
		"utf-8",
	)
	return { env: { KIMCHI_ACTIVE_FERMENT: fermentId, KIMCHI_FERMENTS_DIR: fermentsDir } }
}

function seedCouncilValidation(workDir: string): void {
	writeFileSync(
		join(workDir, "package.json"),
		`${JSON.stringify({
			scripts: {
				test: "node verify.mjs",
			},
		})}\n`,
	)
	writeFileSync(
		join(workDir, "verify.mjs"),
		`import { readFileSync } from 'node:fs'\nif (readFileSync('council-change.txt', 'utf8') !== ${JSON.stringify(COUNCIL_CHANGE_CONTENT)}) process.exit(1)\n`,
	)
}

test("Council reviews, applies, validates, and settles an exact candidate", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "council-progress-private",
			env: councilEnv,
			extraArgs: ["--provider", "kimchi", "--model", "council"],
			models: [privateModel],
			seedHome: (_homeDir, workDir) => seedCouncilValidation(workDir),
			responses: [
				{
					stream: ["Writing", " marker."],
					toolCalls: [
						{
							function: {
								name: "write",
								arguments: JSON.stringify({ path: "council-change.txt", content: COUNCIL_CHANGE_CONTENT }),
							},
						},
					],
				},
				{ stream: ["Reviewed", " Council", " answer."], textDelayMs: 400 },
				{
					thinking: [`<think>${PRIVATE_REASONING_CANARY}</think>`],
					delayMs: 400,
					stream: [
						JSON.stringify({
							schema_version: 3,
							role: "reviewer",
							findings: [
								{
									severity: "medium",
									statement: PRIVATE_REVIEW_CANARY,
									evidence_refs: ["artifact_message_0_block_0_user_text"],
									assumptions: [],
									suggested_check: "Inspect the deterministic output.",
								},
							],
							recommended_changes: [],
						}),
					],
				},
				{
					delayMs: 400,
					stream: [
						JSON.stringify({
							schema_version: 3,
							role: "reviewer",
							findings: [],
							recommended_changes: [],
						}),
					],
				},
				{
					delayMs: 400,
					stream: [
						JSON.stringify({
							schema_version: 1,
							consensus: [],
							contradictions: [],
							unique_findings: [],
							upheld_defects: [],
							required_checks: ["package.test"],
						}),
					],
				},
			],
		},
		async (fixture, trace) => {
			// PROMPT_READY is rendered just before the interactive loop starts waiting
			// for input, so give that startup boundary one tick before submitting.
			await sleep(100)
			terminal.submit(COUNCIL_CHANGE_OBJECTIVE)
			trace.step("submitted Council prompt")

			await waitForText(terminal, "Council · drafting", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expectPrivateTextHidden(terminal)
			trace.step("drafting progress visible")

			await waitForText(terminal, "Council · reviewing", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await expectPrivateTextStaysHidden(terminal, 900)
			expect(existsSync(join(fixture.workDir, "council-change.txt"))).toBe(false)
			trace.step("panel review progress visible without private content")

			await waitForText(terminal, "Council · analyzing", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expectPrivateTextHidden(terminal)
			trace.step("analysis progress visible")

			await expect(terminal.getByText("Reviewed Council answer.", { full: true })).toBeVisible()
			await waitForText(terminal, "Council · accepted", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fullText(terminal)).toContain("Settle Agent Patch")
			expectPrivateTextHidden(terminal)

			const completionLine = fullText(terminal)
				.split("\n")
				.find((line) => line.includes("Council · accepted"))
			expect(completionLine).toBeDefined()
			expect(completionLine).toMatch(/\d+(?:\.\d+)?s/)
			expect(completionLine).not.toContain("$")
			trace.step("safe completion summary rendered without unavailable cost")

			const physicalRequests = physicalChatRequests(fixture).filter((request) =>
				JSON.stringify(request.body ?? "").includes("council-change.txt"),
			)
			expect(readFileSync(join(fixture.workDir, "council-change.txt"), "utf8")).toBe(COUNCIL_CHANGE_CONTENT)
			expect(physicalRequests).toHaveLength(5)
			const bodies = physicalRequests.map((request) => JSON.stringify(request.body ?? ""))
			expect(bodies[0]).toContain("Finish this turn with either a normal user-facing answer or a valid tool call")
			expect(bodies[1]).toContain("Finish this turn with either a normal user-facing answer or a valid tool call")
			expect(bodies[2]).toContain("You are a Council reviewer")
			const firstReviewerPacket = JSON.parse(lastUserText(physicalRequests[2]))
			expect(firstReviewerPacket.role).toBe("reviewer")
			expect(firstReviewerPacket).not.toHaveProperty("blind")
			expect(bodies[3]).toContain("You are a Council reviewer")
			const secondReviewerPacket = JSON.parse(lastUserText(physicalRequests[3]))
			expect(secondReviewerPacket.role).toBe("reviewer")
			expect(secondReviewerPacket).not.toHaveProperty("blind")
			expect(lastUserText(physicalRequests[3])).toBe(lastUserText(physicalRequests[2]))
			expect(bodies[4]).toContain("You are the Council analyst")
			expect(bodies).not.toEqual(
				expect.arrayContaining([expect.stringContaining("Run this exact required command now:")]),
			)
			expect(fullText(terminal)).toContain("$ node verify.mjs")
			for (const request of physicalRequests) {
				const tools = (request.body as { tools?: unknown }).tools
				expect(JSON.stringify(tools ?? [])).not.toContain("apply_agent_patch")
				expect(JSON.stringify(tools ?? [])).not.toContain("settle_agent_patch")
			}
			trace.step("expected physical architecture ran without extra Council turns")
		},
	)
})

test("Council skips review after a read-only tool turn", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "council-read-only",
			env: councilEnv,
			extraArgs: ["--provider", "kimchi", "--model", "council-fast"],
			models: [privateModel],
			seedHome: (_homeDir, workDir) => writeFileSync(join(workDir, "read-only.txt"), "READ_ONLY_OK\n"),
			responses: [
				{
					toolCalls: [
						{
							function: {
								name: "read",
								arguments: JSON.stringify({ path: "read-only.txt" }),
							},
						},
					],
				},
				{ stream: ["Read-only answer: ", "READ_ONLY_OK"], textDelayMs: 300 },
			],
		},
		async (fixture, trace) => {
			await sleep(100)
			terminal.submit("Read read-only.txt and report its contents")
			trace.step("submitted read-only Council prompt")

			await expect(terminal.getByText("Read-only answer: READ_ONLY_OK", { full: true })).toBeVisible()
			await waitForText(terminal, "Council · accepted", { timeoutMs: STREAM_TIMEOUT_MS })
			expectPrivateTextHidden(terminal)

			const physicalRequests = physicalChatRequests(fixture).filter((request) =>
				JSON.stringify(request.body ?? "").includes("read-only.txt"),
			)
			expect(physicalRequests).toHaveLength(2)
			for (const request of physicalRequests) {
				const body = JSON.stringify(request.body ?? "")
				expect(body).not.toContain("You are a Council reviewer")
				expect(body).not.toContain("Council analyst")
			}
			trace.step("read-only turn completed with lead calls only")
		},
	)
})

test("Council preserves a client tool call without starting review", async ({ terminal }) => {
	const fermentId = randomUUID()
	const phaseId = randomUUID()
	await runKimchiSession(
		terminal,
		{
			artifactName: "council-tool-use",
			env: councilEnv,
			extraArgs: ["--provider", "kimchi", "--model", "council-fast"],
			gitInit: true,
			models: [privateModel],
			beforeReady: async (t) => {
				await waitForText(t, "Resume?", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
				t.keyDown()
				t.submit("")
			},
			seedHome: (_homeDir, workDir) => seedPausedFerment(workDir, fermentId, phaseId),
			responses: [
				{
					stream: ["I need your choice."],
					textDelayMs: 400,
					toolCalls: [
						{
							function: {
								name: "ask_user",
								arguments: JSON.stringify({
									questions: [
										{
											id: "route",
											type: "single",
											prompt: "Which route?",
											options: [
												{ id: "safe", label: "Safe route" },
												{ id: "fast", label: "Fast route" },
											],
										},
									],
								}),
							},
						},
					],
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit("Ask me which route to take")
			trace.step("submitted Council tool-use prompt")

			await waitForText(terminal, "Council · drafting", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await waitForText(terminal, "Which route?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Safe route", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Fast route", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Council · tool requested", { timeoutMs: STREAM_TIMEOUT_MS })
			expectPrivateTextHidden(terminal)
			trace.step("ask_user tool call preserved")

			const physicalRequests = physicalChatRequests(fixture).filter((request) =>
				JSON.stringify(request.body ?? "").includes("Ask me which route"),
			)
			expect(physicalRequests).toHaveLength(1)
			expect(JSON.stringify(physicalRequests[0]?.body ?? "")).not.toContain("You are a Council reviewer")
			trace.step("tool-use path skipped review and added no model turn")
		},
	)
})
