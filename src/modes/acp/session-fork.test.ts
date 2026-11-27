import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LoadSessionRequest, SessionNotification } from "@agentclientprotocol/sdk/unstable"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { asSession, BaseFakeAgentSession, makeAcpConn } from "./__mocks__/fake-agent-session.js"
import { KimchiAcpAgent } from "./server.js"

class ForkFakeSession extends BaseFakeAgentSession {
	branch: SessionEntry[] = []
	leafId: string | null = null
	sessionFile: string | undefined
	thinkingLevel = "high"

	constructor(sessionId: string, sessionFile?: string) {
		super(sessionId)
		Object.assign(this.model, { reasoning: true, thinkingLevelMap: { max: "max" } })
		Object.assign(this.modelRegistry, { getAvailable: () => [this.model] })
		this.sessionFile = sessionFile
		Object.defineProperty(this.sessionManager, "getBranch", { value: () => this.branch })
		Object.defineProperty(this.sessionManager, "getLeafId", { value: () => this.leafId })
	}

	clearQueue = () => ({ steering: [] as string[], followUp: [] as string[] })
	setModel = async (model: { provider: string; id: string }) => {
		Object.assign(this.model, model)
	}
	setThinkingLevel = (level: string) => {
		this.thinkingLevel = level
	}
}

function sessionDir(agentDir: string, cwd: string): string {
	return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)
}

function savedSource(agentDir: string, cwd: string, id: string, text: string): string {
	const manager = SessionManager.create(cwd, sessionDir(agentDir, cwd), { id })
	manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() })
	const path = manager.getSessionFile()
	if (!path) throw new Error("expected persisted source path")
	return path
}

function savedSessionPath(agentDir: string, cwd: string, id: string): string {
	const match = readdirSync(sessionDir(agentDir, cwd)).find((file) => file.endsWith(`_${id}.jsonl`))
	if (!match) throw new Error(`session ${id} was not persisted`)
	return join(sessionDir(agentDir, cwd), match)
}

const directories: string[] = []
const agents: KimchiAcpAgent[] = []

afterEach(async () => {
	for (const agent of agents.splice(0).reverse()) await agent.shutdown().catch(() => {})
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeHarness(options: { source?: ForkFakeSession; coldLoader?: boolean; activationFailures?: number } = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "kimchi-acp-fork-"))
	const cwd = join(agentDir, "project")
	directories.push(agentDir)
	const updates: SessionNotification[] = []
	const loadRequests: LoadSessionRequest[] = []
	let factoryCalls = 0
	const conn = makeAcpConn()
	vi.mocked(conn.notify).mockImplementation(async (method, params) => {
		if (method === "session/update") updates.push(params as SessionNotification)
	})
	const agent = new KimchiAcpAgent(conn, {
		extensionFactories: [],
		agentDir,
		sessionFactory: async () => {
			const session =
				factoryCalls === 0 && options.source ? options.source : new ForkFakeSession(`created-${factoryCalls}`)
			factoryCalls += 1
			return asSession(session)
		},
		sessionLoader: async (params) => {
			loadRequests.push(params)
			if ((options.activationFailures ?? 0) >= loadRequests.length) throw new Error("activation failed")
			if (!options.coldLoader && !options.source) throw new Error(`unexpected load of ${params.sessionId}`)
			const path = savedSessionPath(agentDir, params.cwd, params.sessionId)
			const session = new ForkFakeSession(params.sessionId, path)
			session.branch = SessionManager.open(path).getBranch()
			const modelChange = session.branch.findLast((entry) => entry.type === "model_change")
			if (modelChange) await session.setModel({ provider: modelChange.provider, id: modelChange.modelId })
			const thinkingChange = session.branch.findLast((entry) => entry.type === "thinking_level_change")
			if (thinkingChange) session.setThinkingLevel(thinkingChange.thinkingLevel)
			return asSession(session)
		},
	})
	agents.push(agent)
	return { agent, agentDir, cwd, loadRequests, updates }
}

describe("ACP session/fork", () => {
	it("advertises the fork capability", async () => {
		const { agent } = makeHarness()
		const result = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} })
		expect(result.agentCapabilities?.sessionCapabilities?.fork).toEqual({})
	})

	it("copies a live source, activates the fork without replay, and preserves independent history", async () => {
		const source = new ForkFakeSession("source-live")
		const harness = makeHarness({ source })
		const sourcePath = savedSource(harness.agentDir, harness.cwd, "source-live", "source transcript")
		source.sessionFile = sourcePath
		const sourceManager = SessionManager.open(sourcePath)
		source.branch = sourceManager.getBranch()
		source.leafId = sourceManager.getLeafId()
		Object.defineProperty(source.sessionManager, "getCwd", { value: () => harness.cwd })
		await harness.agent.newSession({ cwd: harness.cwd, mcpServers: [] })

		const result = await harness.agent.forkSession({
			sessionId: "source-live",
			cwd: harness.cwd,
			mcpServers: [],
		})

		expect(result.sessionId).not.toBe("source-live")
		expect(result.configOptions).toBeDefined()
		expect(harness.loadRequests.map((request) => request.sessionId)).toEqual([result.sessionId])
		const forkPath = savedSessionPath(harness.agentDir, harness.cwd, result.sessionId)
		const initialSource = readFileSync(sourcePath, "utf8")
		expect(readFileSync(forkPath, "utf8")).toContain("source transcript")
		expect(
			harness.updates.some(
				(update) =>
					update.sessionId === result.sessionId &&
					(update.update.sessionUpdate === "user_message_chunk" ||
						update.update.sessionUpdate === "agent_message_chunk"),
			),
		).toBe(false)

		SessionManager.open(forkPath).appendMessage({
			role: "user",
			content: [{ type: "text", text: "fork only" }],
			timestamp: Date.now(),
		})
		expect(readFileSync(forkPath, "utf8")).toContain("fork only")
		expect(readFileSync(sourcePath, "utf8")).toBe(initialSource)
	})

	it("forks a persisted source that is not currently loaded", async () => {
		const setup = makeHarness({ coldLoader: true })
		const sourcePath = savedSource(setup.agentDir, setup.cwd, "source-cold", "cold transcript")
		const sourceBefore = readFileSync(sourcePath, "utf8")

		const result = await setup.agent.forkSession({ sessionId: "source-cold", cwd: setup.cwd, mcpServers: [] })

		expect(result.sessionId).not.toBe("source-cold")
		expect(readFileSync(savedSessionPath(setup.agentDir, setup.cwd, result.sessionId), "utf8")).toContain(
			"cold transcript",
		)
		expect(readFileSync(sourcePath, "utf8")).toBe(sourceBefore)
	})

	it("filters inherited child associations and stamps affirmative ACP provenance", async () => {
		const setup = makeHarness({ coldLoader: true })
		const sourcePath = savedSource(setup.agentDir, setup.cwd, "source-with-child", "source transcript")
		const manager = SessionManager.open(sourcePath)
		const recordId = manager.appendCustomEntry("subagents:record", {
			id: "child-task",
			agentId: "Reviewer",
			sessionId: "child-session",
			parentSessionId: "source-with-child",
			toolCallId: "parent-spawn",
			description: "Review source",
			cwd: "/tmp/child-review",
			sessionFile: "/tmp/child.jsonl",
		})
		// Exercise removal while the subagent routing record is the selected leaf.
		manager.branch(recordId)
		const before = readFileSync(sourcePath, "utf8")

		const result = await setup.agent.forkSession({ sessionId: "source-with-child", cwd: setup.cwd, mcpServers: [] })

		const forkPath = savedSessionPath(setup.agentDir, setup.cwd, result.sessionId)
		const forkContents = readFileSync(forkPath, "utf8")
		expect(forkContents).not.toContain('"customType":"subagents:record"')
		expect(forkContents.split("\n")[1]).toContain('"customType":"kimchi:acp-fork"')
		expect(readFileSync(sourcePath, "utf8")).toBe(before)
		expect(forkContents).toContain("source transcript")
	})

	it("rejects a parented source without affirmative ACP-fork provenance", async () => {
		const setup = makeHarness({ coldLoader: true })
		const directory = sessionDir(setup.agentDir, setup.cwd)
		const manager = SessionManager.create(setup.cwd, directory, {
			id: "unknown-child",
			parentSession: "/tmp/unknown-parent.jsonl",
		})
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "child transcript" }], timestamp: 1 })
		const sourcePath = manager.getSessionFile()
		if (!sourcePath) throw new Error("expected child transcript")

		await expect(
			setup.agent.forkSession({ sessionId: "unknown-child", cwd: setup.cwd, mcpServers: [] }),
		).rejects.toMatchObject({ code: -32602 })
		expect(setup.loadRequests).toEqual([])
	})

	it("preserves lineage and settings when Pi assigned a path and in-memory config before persistence", async () => {
		const source = new ForkFakeSession("source-empty")
		const { agent, agentDir, cwd, loadRequests } = makeHarness({ source })
		const manager = SessionManager.create(cwd, sessionDir(agentDir, cwd), { id: "source-empty" })
		manager.appendModelChange("test", "test-model")
		manager.appendThinkingLevelChange("max")
		const sourcePath = manager.getSessionFile()
		if (!sourcePath) throw new Error("expected source path")
		source.sessionFile = sourcePath
		source.branch = manager.getBranch()
		source.leafId = manager.getLeafId()
		await agent.newSession({ cwd, mcpServers: [] })

		const result = await agent.forkSession({ sessionId: "source-empty", cwd, mcpServers: [] })

		expect(result.sessionId).not.toBe("source-empty")
		expect(result.configOptions).toBeDefined()
		expect(loadRequests.map((request) => request.sessionId)).toEqual([result.sessionId])
		const forkPath = savedSessionPath(agentDir, cwd, result.sessionId)
		const contents = readFileSync(forkPath, "utf8")
		const header = JSON.parse(contents.split("\n")[0]) as { parentSession?: string }
		expect(header.parentSession).toBe(sourcePath)
		expect(contents).toContain('"type":"model_change"')
		expect(contents).toContain('"thinkingLevel":"max"')
		expect(result.configOptions?.find((option) => option.id === "reasoning_effort")?.currentValue).toBe("max")

		await agent.closeSession({ sessionId: result.sessionId })
		const resumed = await agent.resumeSession({ sessionId: result.sessionId, cwd, mcpServers: [] })
		expect(resumed.configOptions?.find((option) => option.id === "reasoning_effort")?.currentValue).toBe("max")
	})

	it("forks at the live manager leaf rather than the disk leaf", async () => {
		const source = new ForkFakeSession("source-live-leaf")
		const harness = makeHarness({ source })
		const manager = SessionManager.create(harness.cwd, sessionDir(harness.agentDir, harness.cwd), {
			id: "source-live-leaf",
		})
		const firstId = manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "selected live message" }],
			timestamp: 1,
		})
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "later disk-only message" }],
			timestamp: 2,
		})
		manager.branch(firstId)
		const sourcePath = manager.getSessionFile()
		if (!sourcePath) throw new Error("expected source path")
		source.sessionFile = sourcePath
		source.branch = manager.getBranch()
		source.leafId = firstId
		Object.defineProperty(source.sessionManager, "getCwd", { value: () => harness.cwd })
		await harness.agent.newSession({ cwd: harness.cwd, mcpServers: [] })

		const result = await harness.agent.forkSession({ sessionId: "source-live-leaf", cwd: harness.cwd, mcpServers: [] })

		const forkContents = readFileSync(savedSessionPath(harness.agentDir, harness.cwd, result.sessionId), "utf8")
		expect(forkContents).toContain("selected live message")
		expect(forkContents).not.toContain("later disk-only message")
	})

	it("does not warn while creating a fresh fork target", async () => {
		const setup = makeHarness({ coldLoader: true })
		savedSource(setup.agentDir, setup.cwd, "source-no-warning", "source transcript")
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			await setup.agent.forkSession({ sessionId: "source-no-warning", cwd: setup.cwd, mcpServers: [] })
			expect(warnings.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain("log offset scan failed")
		} finally {
			warnings.mockRestore()
		}
	})

	it.each([
		{ field: "id" as const, expected: "wrong-id" },
		{ field: "cwd" as const, expected: "/different/project" },
	])("rejects a cold source whose header $field does not match the request", async ({ field, expected }) => {
		const setup = makeHarness({ coldLoader: true })
		const sourcePath = savedSource(setup.agentDir, setup.cwd, "source-header", "source transcript")
		const lines = readFileSync(sourcePath, "utf8").split("\n")
		const header = JSON.parse(lines[0]) as Record<string, unknown>
		header[field] = expected
		lines[0] = JSON.stringify(header)
		writeFileSync(sourcePath, lines.join("\n"))

		await expect(
			setup.agent.forkSession({ sessionId: "source-header", cwd: setup.cwd, mcpServers: [] }),
		).rejects.toMatchObject({ code: -32602 })
		expect(setup.loadRequests).toEqual([])
	})

	it("removes a newly copied fork when activation fails", async () => {
		const setup = makeHarness({ coldLoader: true, activationFailures: 2 })
		const sourcePath = savedSource(setup.agentDir, setup.cwd, "source-cleanup", "source transcript")

		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				setup.agent.forkSession({ sessionId: "source-cleanup", cwd: setup.cwd, mcpServers: [] }),
			).rejects.toThrow("activation failed")
		}

		expect(readFileSync(sourcePath, "utf8")).toContain("source transcript")
		expect(readdirSync(sessionDir(setup.agentDir, setup.cwd)).filter((file) => file.endsWith(".jsonl"))).toHaveLength(1)
	})

	it("preserves migrated legacy history and the exact source bytes", async () => {
		const setup = makeHarness({ coldLoader: true })
		const directory = sessionDir(setup.agentDir, setup.cwd)
		mkdirSync(directory, { recursive: true })
		const sourcePath = join(directory, "legacy_source-legacy.jsonl")
		writeFileSync(
			sourcePath,
			[
				{ type: "session", version: 1, id: "source-legacy", cwd: setup.cwd, timestamp: "2026-01-01T00:00:00Z" },
				{
					type: "message",
					id: "first",
					parentId: null,
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: "first legacy message", timestamp: 0 },
				},
				{
					type: "message",
					id: "second",
					parentId: "first",
					timestamp: "2026-01-01T00:00:02Z",
					message: { role: "user", content: "second legacy message", timestamp: 0 },
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		)
		const sourceBefore = readFileSync(sourcePath, "utf8")
		const expectLegacyMessages = (path: string) => {
			const messages = SessionManager.open(path)
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
			expect(messages).toHaveLength(2)
			expect(JSON.stringify(messages)).toContain("first legacy message")
			expect(JSON.stringify(messages)).toContain("second legacy message")
		}
		const result = await setup.agent.forkSession({ sessionId: "source-legacy", cwd: setup.cwd, mcpServers: [] })

		expectLegacyMessages(savedSessionPath(setup.agentDir, setup.cwd, result.sessionId))
		expect(readFileSync(sourcePath, "utf8")).toBe(sourceBefore)
	})

	it("rejects unsupported cursor forks before copying anything", async () => {
		const { agent, cwd } = makeHarness()
		await expect(
			agent.forkSession({ sessionId: "missing", cwd, cursorId: "cursor-1", mcpServers: [] }),
		).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("cursor") })
	})

	it("rejects initial config options that are not advertised", async () => {
		const { agent, cwd } = makeHarness()
		await expect(
			agent.forkSession({
				sessionId: "missing",
				cwd,
				configOptions: [{ configId: "model", value: "test/test-model" }],
				mcpServers: [],
			}),
		).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("configOptions") })
	})

	it("rejects an unknown source session", async () => {
		const { agent, cwd } = makeHarness()
		await expect(agent.forkSession({ sessionId: "missing", cwd, mcpServers: [] })).rejects.toMatchObject({
			code: -32602,
			message: expect.stringContaining("unknown or unsaved source session"),
		})
	})

	it("rejects forking a session with an active turn", async () => {
		const source = new ForkFakeSession("source-active")
		const { agent, cwd } = makeHarness({ source })
		await agent.newSession({ cwd, mcpServers: [] })
		const internals = agent as unknown as { sessions: Map<string, { turn?: object }> }
		const record = internals.sessions.get("source-active")
		if (!record) throw new Error("active source was not registered")
		record.turn = {}

		await expect(agent.forkSession({ sessionId: "source-active", cwd, mcpServers: [] })).rejects.toMatchObject({
			code: -32600,
			message: expect.stringContaining("work in progress"),
		})
	})
})
