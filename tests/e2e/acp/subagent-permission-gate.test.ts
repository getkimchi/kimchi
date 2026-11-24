import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor } from "./support/scenarios.js"

const WRITE_ARGS = JSON.stringify({ path: "output.txt", content: "hello world" })
const CHILD_DONE = "ACP-CHILD-PERMISSION-DONE"
const PARENT_DONE = "ACP-PARENT-PERMISSION-DONE"
const USER_PROMPT = "Have a subagent create output.txt and then report the outcome"
const MODELS = [
	{ slug: "basic", displayName: "Fake Basic", provider: "ai-enabler", contextWindow: 64_000, maxTokens: 8192 },
	{
		slug: "deepseek-v4-flash-0731",
		displayName: "Classifier",
		provider: "ai-enabler",
		contextWindow: 64_000,
		maxTokens: 8192,
	},
]

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

describe("ACP integration — subagent permission gate", () => {
	let fixture: AcpFixture

	afterEach(async () => {
		await fixture.stop()
	})

	describe("classifier rejection in default mode", () => {
		beforeEach(async () => {
			fixture = await startAcpFixture({
				artifactName: "subagent-acp-classifier-deny",
				providerId: "kimchi-dev",
				models: MODELS,
				responses: [
					{
						match: (request) => JSON.stringify(request.body ?? {}).includes(USER_PROMPT),
						stream: ["Delegating."],
						toolCalls: [agentCall()],
					},
					{
						forSubagent: true,
						stream: ["I'll create the file."],
						toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
					},
					{
						match: (request) => isClassifierRequest(request.body),
						stream: [
							'{"verdict":"requires-confirmation","reason":"The worker cannot ask for approval","riskScore":"high"}',
						],
					},
					{ forSubagent: true, stream: [CHILD_DONE] },
					{
						match: (request) => JSON.stringify(request.body ?? {}).includes(CHILD_DONE),
						stream: [PARENT_DONE],
					},
				],
			})
		}, STARTUP_TIMEOUT_MS)

		it("asks the parent client and runs the write when approved", async () => {
			const sessionId = await newSession(fixture, fixture.workDir)
			const result = await prompt(fixture, sessionId, USER_PROMPT)

			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toContain(PARENT_DONE)
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(true)
			expect(fixture.client.permissionRequests).toHaveLength(1)
			expect(fixture.client.permissionRequests[0]?.toolCall.title).toMatch(/^Subagent General-Purpose: /)
			expect(fixture.fake.requests.filter((request) => isClassifierRequest(request.body)).length).toBeGreaterThan(0)
		})
	})

	describe("trusted project config deny rule", () => {
		beforeEach(async () => {
			fixture = await startAcpFixture({
				artifactName: "subagent-acp-config-deny",
				responses: [
					{
						match: (request) => JSON.stringify(request.body ?? {}).includes(USER_PROMPT),
						stream: ["Delegating."],
						toolCalls: [agentCall()],
					},
					{
						forSubagent: true,
						stream: ["I'll create the file."],
						toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
					},
					{ forSubagent: true, stream: [CHILD_DONE] },
					{
						match: (request) => JSON.stringify(request.body ?? {}).includes(CHILD_DONE),
						stream: [PARENT_DONE],
					},
				],
				pretrustWorkDir: true,
			})
			mkdirSync(join(fixture.workDir, ".kimchi"), { recursive: true })
			writeFileSync(
				join(fixture.workDir, ".kimchi", "permissions.json"),
				JSON.stringify({ defaultMode: "yolo", deny: ["write"] }),
			)
		}, STARTUP_TIMEOUT_MS)

		it("enforces the config deny without classifier or client prompt", async () => {
			const sessionId = await newSession(fixture, fixture.workDir)
			const result = await prompt(fixture, sessionId, USER_PROMPT)

			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toContain(PARENT_DONE)
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(false)
			expect(fixture.client.permissionRequests).toHaveLength(0)
			expect(fixture.fake.requests.filter((request) => isClassifierRequest(request.body))).toHaveLength(0)
		})
	})

	describe("client-selected mode versus config fallback", () => {
		let releaseChild: (() => void) | undefined
		beforeEach(async () => {
			const childHold = new Promise<void>((resolve) => {
				releaseChild = resolve
			})
			fixture = await startAcpFixture({
				artifactName: "subagent-acp-client-plan-mode",
				responses: [
					{
						match: (request) => JSON.stringify(request.body ?? {}).includes(USER_PROMPT),
						stream: ["Delegating."],
						toolCalls: [agentCall(true)],
					},
					{
						match: (request) => JSON.stringify(request.body ?? {}).includes("agent_id"),
						stream: ["ACP-BACKGROUND-CHILD-STARTED"],
					},
					{
						forSubagent: true,
						holdUntil: childHold,
						stream: ["I'll create the file."],
						toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
					},
					{ forSubagent: true, stream: [CHILD_DONE] },
				],
				pretrustWorkDir: true,
			})
			mkdirSync(join(fixture.workDir, ".kimchi"), { recursive: true })
			writeFileSync(join(fixture.workDir, ".kimchi", "permissions.json"), JSON.stringify({ defaultMode: "yolo" }))
		}, STARTUP_TIMEOUT_MS)

		it("follows the client-selected plan mode instead of the config-file yolo fallback", async () => {
			const sessionId = await newSession(fixture, fixture.workDir)
			const result = await prompt(fixture, sessionId, USER_PROMPT)
			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toContain("ACP-BACKGROUND-CHILD-STARTED")
			await waitFor(
				() =>
					fixture.fake.requests.filter((request) => JSON.stringify(request.body ?? {}).includes("sub-agent")).length,
				(count) => count > 0,
			)

			await fixture.conn.request("session/set_config_option", {
				sessionId,
				configId: "permissions-mode",
				value: "plan",
			})
			if (!releaseChild) throw new Error("child release was not initialized")
			releaseChild()
			await waitFor(
				() =>
					fixture.fake.requests.filter((request) => JSON.stringify(request.body ?? {}).includes("plan mode")).length,
				(count) => count > 0,
			)
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(false)
			expect(fixture.client.permissionRequests).toHaveLength(0)
			expect(fixture.fake.requests.filter((request) => isClassifierRequest(request.body))).toHaveLength(0)
		})
	})
})
