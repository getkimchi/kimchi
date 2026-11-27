import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

it("does not adopt delegated sessions when forking and reopening", async () => {
	const fixture = await startAcpFixture({
		artifactName: "fork-does-not-adopt-child",
		clientCapabilities: { subagents: {} },
		responses: [
			{
				match: (request) => requestBody(request).includes(PARENT_REQUEST),
				toolCalls: [
					{
						function: {
							name: "Agent",
							arguments: JSON.stringify({
								prompt: CHILD_TASK,
								description: "Durable child",
								subagent_type: "general-purpose",
							}),
						},
					},
				],
			},
			{
				forSubagent: true,
				match: (request) => requestBody(request).includes(CHILD_TASK),
				toolCalls: [
					{
						function: { name: "read", arguments: JSON.stringify({ path: "child-source.txt" }) },
					},
				],
			},
			{ forSubagent: true, stream: [CHILD_RESULT] },
			{ stream: ["Parent accepted the child result."] },
		],
	})
	try {
		const sourceId = await newSession(fixture, fixture.workDir)
		expect((await prompt(fixture, sourceId, PARENT_REQUEST)).stopReason).toBe("end_turn")
		const announcement = fixture.client.sessionUpdates.find(({ update }) => update.sessionUpdate === "subagent_update")
		if (announcement?.update.sessionUpdate !== "subagent_update") {
			throw new Error("Missing child announcement")
		}

		const fork = await fixture.conn.request("session/fork", {
			sessionId: sourceId,
			cwd: fixture.workDir,
			mcpServers: [],
		})
		const childUpdates = () =>
			fixture.client.sessionUpdates.filter(
				({ sessionId, update }) => sessionId === fork.sessionId && update.sessionUpdate === "subagent_update",
			)
		expect(childUpdates()).toHaveLength(0)
		const forkContents = logFor(fixture.homeDir, fork.sessionId)
		expect(forkContents).toContain(PARENT_REQUEST)
		expect(forkContents).toContain(CHILD_RESULT)
		expect(forkContents).not.toContain('"customType":"subagents:record"')
		const sourceBeforeResume = logFor(fixture.homeDir, sourceId)

		await fixture.conn.request("session/close", { sessionId: fork.sessionId })
		await fixture.conn.request("session/resume", { sessionId: fork.sessionId, cwd: fixture.workDir, mcpServers: [] })

		expect(childUpdates()).toHaveLength(0)
		expect(logFor(fixture.homeDir, fork.sessionId)).toContain(PARENT_REQUEST)
		expect(logFor(fixture.homeDir, sourceId)).toBe(sourceBeforeResume)
	} finally {
		await fixture.stop()
	}
}, 90_000)

it("forks a source at its tip and activates an independent session without replay", async () => {
	const fixture = await startAcpFixture({
		artifactName: "session-fork",
		responses: [{ stream: ["source reply"] }, { stream: ["fork reply"] }],
	})
	try {
		expect(fixture.initializeResponse.agentCapabilities.sessionCapabilities?.fork).toEqual({})
		const sourceId = await newSession(fixture, fixture.workDir)
		expect((await prompt(fixture, sourceId, "source question")).stopReason).toBe("end_turn")

		const fork = await fixture.conn.request("session/fork", {
			sessionId: sourceId,
			cwd: fixture.workDir,
			mcpServers: [],
		})
		expect(fork.sessionId).not.toBe(sourceId)
		expect(fork.configOptions).toBeDefined()
		// BB already owns the copied thread history. A fork response activates the
		// session; unlike session/load, it must not emit a duplicate transcript.
		expect(fixture.client.agentTextBySession().get(fork.sessionId) ?? "").toBe("")

		const forkTurn = await prompt(fixture, fork.sessionId, "fork question")
		expect(forkTurn.stopReason).toBe("end_turn")
		expect(forkTurn.chunks).toBe("fork reply")
		expect(fixture.client.agentTextBySession().get(sourceId)).toBe("source reply")

		const sessionsRoot = join(fixture.homeDir, ".config", "kimchi", "harness", "sessions")
		const sessionLog = (id: string) => {
			for (const project of readdirSync(sessionsRoot)) {
				for (const file of readdirSync(join(sessionsRoot, project))) {
					if (file.endsWith(`_${id}.jsonl`)) return readFileSync(join(sessionsRoot, project, file), "utf8")
				}
			}
			return ""
		}
		const sourceLog = sessionLog(sourceId)
		const forkLog = sessionLog(fork.sessionId)
		expect(sourceLog).toContain("source question")
		expect(sourceLog).toContain("source reply")
		expect(sourceLog).not.toContain("fork question")
		expect(forkLog).toContain("source question")
		expect(forkLog).toContain("source reply")
		expect(forkLog).toContain("fork question")
		expect(forkLog).toContain("fork reply")

		const listed = await fixture.conn.request("session/list", { cwd: fixture.workDir, mcpServers: [] })
		const listedIds = listed.sessions.map((session) => session.sessionId)
		expect(listedIds).toContain(sourceId)
		// Preserve the legacy default: no new parented sessions appear for
		// clients that did not negotiate a visibility extension.
		expect(listedIds).not.toContain(fork.sessionId)
	} finally {
		await fixture.stop()
	}
}, 90_000)

const branchFixturePath = fileURLToPath(new URL("../fixtures/session-fork-branch.js", import.meta.url))

const CHILD_TASK = "Read child-source.txt and return the persisted child marker."
const PARENT_REQUEST = "Delegate the durable child investigation."
const CHILD_RESULT = "persisted-child-result"

function requestBody(request: { body?: unknown }): string {
	return JSON.stringify(request.body ?? {})
}

function logFor(homeDir: string, id: string): string {
	const root = join(homeDir, ".config", "kimchi", "harness", "sessions")
	const path = readdirSync(root, { recursive: true }).find((entry) => entry.endsWith(`_${id}.jsonl`))
	if (!path) throw new Error(`No log for ${id}`)
	return readFileSync(join(root, path), "utf8")
}

it("preserves an explicitly selected reasoning level when activating an empty fork", async () => {
	const fixture = await startAcpFixture({
		artifactName: "fork-empty-config",
		providerId: "kimchi-dev",
		defaultProvider: "kimchi-dev",
		defaultModel: "glm-5.3",
		models: [
			{
				slug: "glm-5.3",
				displayName: "GLM 5.3",
				provider: "ai-enabler",
				reasoning: true,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 8192,
				metadata: { thinking_levels: ["low", "high", "max"] },
			},
		],
		responses: [],
	})
	try {
		const cwd = fixture.workDir
		const source = await fixture.conn.request("session/new", { cwd, mcpServers: [] })
		const current = (options: typeof source.configOptions) =>
			options?.find((option) => option.id === "reasoning_effort")?.currentValue
		const updated = await fixture.conn.request("session/set_config_option", {
			sessionId: source.sessionId,
			configId: "reasoning_effort",
			value: "max",
		})
		expect(current(updated.configOptions)).toBe("max")

		const fork = await fixture.conn.request("session/fork", { sessionId: source.sessionId, cwd, mcpServers: [] })

		expect(current(fork.configOptions)).toBe("max")
		await fixture.conn.request("session/close", { sessionId: fork.sessionId })
		const resumed = await fixture.conn.request("session/resume", { sessionId: fork.sessionId, cwd, mcpServers: [] })
		expect(current(resumed.configOptions)).toBe("max")
	} finally {
		await fixture.stop()
	}
}, 90_000)

it("forks a fresh model without selectable thinking levels", async () => {
	const fixture = await startAcpFixture({
		artifactName: "fork-empty-non-reasoning",
		defaultModel: "basic-non-reasoning",
		models: [
			{
				slug: "basic-non-reasoning",
				displayName: "Basic non-reasoning",
				provider: "test",
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
		responses: [],
	})
	try {
		const cwd = fixture.workDir
		const source = await fixture.conn.request("session/new", { cwd, mcpServers: [] })

		const fork = await fixture.conn.request("session/fork", { sessionId: source.sessionId, cwd, mcpServers: [] })

		expect(fork.sessionId).not.toBe(source.sessionId)
		expect(fork.configOptions?.find((option) => option.id === "reasoning_effort")).toBeUndefined()
	} finally {
		await fixture.stop()
	}
}, 90_000)

it("materializes durable content for a compacted live fork without source markers", async () => {
	const fixture = await startAcpFixture({
		artifactName: "fork-compacted-markers",
		extensionPath: branchFixturePath,
		responses: [{ stream: ["first reply"] }, { stream: ["second reply"] }],
	})
	try {
		const cwd = fixture.workDir
		const sessionId = await newSession(fixture, cwd)
		const first = `archived-old-text-${"A".repeat(400)}`
		await prompt(fixture, sessionId, first)
		await prompt(fixture, sessionId, "second input")
		expect((await prompt(fixture, sessionId, "/fork-test-compact")).stopReason).toBe("end_turn")
		expect(logFor(fixture.homeDir, sessionId)).toContain(first)

		const fork = await fixture.conn.request("session/fork", { sessionId, cwd, mcpServers: [] })

		const transcript = logFor(fixture.homeDir, fork.sessionId)
		expect(transcript).toContain("fixture compaction summary")
		expect(transcript).toContain(first)
		expect(transcript).not.toContain("[kimchi-ext:log]")
	} finally {
		await fixture.stop()
	}
}, 90_000)
