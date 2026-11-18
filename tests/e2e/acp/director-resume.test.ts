import { readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

function sessionLogFile(homeDir: string, sessionId: string): string {
	const sessionsRoot = join(homeDir, ".config", "kimchi", "harness", "sessions")
	for (const directory of readdirSync(sessionsRoot)) {
		for (const file of readdirSync(join(sessionsRoot, directory))) {
			if (file.endsWith(`_${sessionId}.jsonl`)) return join(sessionsRoot, directory, file)
		}
	}
	throw new Error(`no session log for ${sessionId}`)
}

const staleWorkerPlan = {
	tasks: [],
	currentPhase: "recovery",
	decisions: [],
	contracts: [],
	assumptions: ["Durable plan outlives the original process"],
	ownership: [],
	workers: {
		"stale-local": {
			id: "stale-local",
			type: "Builder",
			description: "Old process work",
			status: "queued",
			disposition: "owned",
			artifactPaths: [],
		},
	},
	verification: [],
	openQuestions: [],
	artifactPaths: [],
}

describe("ACP integration — Director resume reconciliation", () => {
	let first: AcpFixture | undefined
	let second: AcpFixture | undefined
	let homeDir: string | undefined
	let workDir: string | undefined

	afterEach(async () => {
		await first?.stop()
		await second?.stop()
		if (homeDir) rmSync(homeDir, { recursive: true, force: true })
		if (workDir) rmSync(workDir, { recursive: true, force: true })
	})

	it(
		"restores the plan and blocks new workers until a stale worker is reconciled",
		async () => {
			first = await startAcpFixture({
				artifactName: "acp-director-resume-first",
				responses: [
					{
						toolCalls: [
							{
								function: {
									name: "director_plan",
									arguments: JSON.stringify({ action: "update", expectedRevision: 1, plan: staleWorkerPlan }),
								},
							},
						],
					},
				],
				pretrustWorkDir: true,
				keepDirsOnStop: true,
			})
			const sessionId = await newSession(first, first.workDir)
			await prompt(first, sessionId, "/skill:director recover objective")
			homeDir = first.homeDir
			workDir = first.workDir
			await first.stop()
			first = undefined

			second = await startAcpFixture({
				artifactName: "acp-director-resume-second",
				responses: [
					{
						toolCalls: [
							{
								function: {
									name: "Agent",
									arguments: JSON.stringify({
										prompt: "Do duplicate work",
										description: "Duplicate",
										subagent_type: "Builder",
									}),
								},
							},
						],
					},
					{ stream: ["Recovery required."] },
				],
				pretrustWorkDir: true,
				homeDirOverride: homeDir,
				workDirOverride: workDir,
			})
			await second.conn.loadSession({ sessionId, cwd: workDir, mcpServers: [] })

			const restored = readFileSync(sessionLogFile(homeDir, sessionId), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { customType?: string; data?: unknown })
				.findLast((entry) => entry.customType === "director-mode/v1") as {
				customType?: string
				data?: { status?: string; plan?: { workers?: Record<string, { disposition?: string }> } }
			}
			expect(restored.customType).toBe("director-mode/v1")
			expect(restored.data?.status).toBe("active")
			expect(restored.data?.plan?.workers?.["stale-local"]?.disposition).toBe("uncertain")

			await prompt(second, sessionId, "spawn another worker")
			const log = readFileSync(sessionLogFile(homeDir, sessionId), "utf8")
			expect(log).toContain("Reconcile stale workers before new delegation: stale-local")
			const successfulAgentResults = log
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as { type?: string; message?: { role?: string; toolName?: string; isError?: boolean } },
				)
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message?.role === "toolResult" &&
						entry.message.toolName === "Agent" &&
						entry.message.isError !== true,
				)
			expect(successfulAgentResults).toHaveLength(0)
		},
		STARTUP_TIMEOUT_MS * 2 + 60_000,
	)
})
