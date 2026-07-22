import { randomUUID } from "node:crypto"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
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
const PRIVATE_MARKERS = [
	PHYSICAL_MODEL_REF,
	PHYSICAL_MODEL_SLUG,
	PHYSICAL_MODEL_DISPLAY,
	PRIVATE_REVIEW_CANARY,
	PRIVATE_REASONING_CANARY,
]

const councilEnv = {
	KIMCHI_COUNCIL_LEAD_MODEL: PHYSICAL_MODEL_REF,
	KIMCHI_COUNCIL_LEAD_FALLBACK_MODELS: "",
	KIMCHI_COUNCIL_INDEPENDENT_MODEL: PHYSICAL_MODEL_REF,
	KIMCHI_COUNCIL_INDEPENDENT_FALLBACK_MODELS: "",
	KIMCHI_COUNCIL_CRITIC_MODEL: PHYSICAL_MODEL_REF,
	KIMCHI_COUNCIL_CRITIC_FALLBACK_MODELS: "",
	KIMCHI_COUNCIL_CHECKER_MODEL: PHYSICAL_MODEL_REF,
	KIMCHI_COUNCIL_CHECKER_FALLBACK_MODELS: "",
	KIMCHI_COUNCIL_JUDGE_MODEL: PHYSICAL_MODEL_REF,
	KIMCHI_COUNCIL_JUDGE_FALLBACK_MODELS: "",
	KIMCHI_COUNCIL_MAX_PARALLEL_REVIEWERS: "1",
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

test("Council shows private progress and a safe completion summary", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "council-progress-private",
			env: councilEnv,
			extraArgs: ["--provider", "kimchi", "--model", "council"],
			models: [privateModel],
			responses: [
				{ stream: ["Reviewed", " Council", " answer."], textDelayMs: 400 },
				{
					thinking: [`<think>${PRIVATE_REASONING_CANARY}</think>`],
					delayMs: 400,
					stream: [
						JSON.stringify({
							schema_version: 1,
							role: "independent",
							decision: "accept",
							findings: [],
							recommended_changes: [],
							missing_evidence: [],
							independent_solution: PRIVATE_REVIEW_CANARY,
							key_claims: [],
							assumptions: [],
							risks: [],
							required_checks: [],
						}),
					],
				},
				{
					delayMs: 400,
					stream: [
						JSON.stringify({
							schema_version: 1,
							role: "critic",
							decision: "accept",
							findings: [],
							recommended_changes: [],
							missing_evidence: [],
							challenged_assumptions: [],
							counterexamples: [],
							affected_claims: [],
						}),
					],
				},
				{
					delayMs: 400,
					stream: [
						JSON.stringify({
							schema_version: 1,
							decision: "accept",
							dispositions: [],
							consensus: [],
							contradictions: [],
							partial_coverage: [],
							unique_insights: [],
							blind_spots: [],
							unsupported_claims: [],
							required_checks: [],
							revision_instructions: [],
							agreement: "high",
						}),
					],
				},
			],
		},
		async (fixture, trace) => {
			// PROMPT_READY is rendered just before the interactive loop starts waiting
			// for input, so give that startup boundary one tick before submitting.
			await sleep(100)
			terminal.submit("Give me a short verified answer")
			trace.step("submitted Council prompt")

			await waitForText(terminal, "Council · drafting", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expectPrivateTextHidden(terminal)
			trace.step("drafting progress visible")

			await waitForText(terminal, "Council · reviewing", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await waitForText(terminal, "independent", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await expectPrivateTextStaysHidden(terminal, 900)
			trace.step("independent progress visible without private content")

			await waitForText(terminal, "critic", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expectPrivateTextHidden(terminal)
			trace.step("critic progress visible separately")

			await waitForText(terminal, "Council · adjudicating", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expectPrivateTextHidden(terminal)
			trace.step("adjudication progress visible")

			await expect(terminal.getByText("Reviewed Council answer.", { full: true })).toBeVisible()
			await waitForText(terminal, "Council · accepted", { timeoutMs: STREAM_TIMEOUT_MS })
			expectPrivateTextHidden(terminal)

			const completionLine = fullText(terminal)
				.split("\n")
				.find((line) => line.includes("Council · accepted"))
			expect(completionLine).toBeDefined()
			expect(completionLine).toContain("high agreement")
			expect(completionLine).toMatch(/\d+(?:\.\d+)?s/)
			expect(completionLine).not.toContain("$")
			trace.step("safe completion summary rendered without unavailable cost")

			const physicalRequests = physicalChatRequests(fixture)
			expect(physicalRequests).toHaveLength(4)
			const bodies = physicalRequests.map((request) => JSON.stringify(request.body ?? ""))
			expect(bodies[0]).toContain("Finish this turn with either a normal user-facing answer or a valid tool call")
			expect(bodies[1]).toContain("You are a Council reviewer")
			expect(JSON.parse(lastUserText(physicalRequests[1])).role).toBe("independent")
			expect(bodies[2]).toContain("You are a Council reviewer")
			expect(JSON.parse(lastUserText(physicalRequests[2])).role).toBe("critic")
			expect(bodies[3]).toContain("You are the Council judge")
			trace.step("expected physical architecture ran without extra Council turns")
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

			const physicalRequests = physicalChatRequests(fixture)
			expect(physicalRequests).toHaveLength(1)
			expect(JSON.stringify(physicalRequests[0]?.body ?? "")).not.toContain("You are a Council reviewer")
			trace.step("tool-use path skipped review and added no model turn")
		},
	)
})
