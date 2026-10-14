import type { CompactionResult } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { BaseFakeAgentSession, makeAcpConn, makeAcpSessionFactory } from "../__mocks__/fake-agent-session.js"
import { AVAILABLE_EXT_METHODS } from "../capabilities.js"
import { KimchiAcpAgent } from "../server.js"

class FakeAgentSession extends BaseFakeAgentSession {
	isCompacting = false
	getContextUsage = () => undefined
	abortCompaction = vi.fn(() => {
		this.isCompacting = false
	})
	compact = vi.fn(
		async (_customInstructions?: string, _force?: boolean): Promise<CompactionResult> => ({
			summary: "compacted summary",
			firstKeptEntryId: "entry-42",
			tokensBefore: 12_000,
		}),
	)

	// Tests control when a turn finishes to exercise the compact-during-turn path.
	private promptResolve: (() => void) | undefined
	override prompt(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.promptResolve = resolve
		})
	}
	finishTurn(): void {
		this.promptResolve?.()
	}
	override dispose(): void {
		this.finishTurn()
		super.dispose()
	}
}

function makeAgent(session: FakeAgentSession) {
	return new KimchiAcpAgent(makeAcpConn(), {
		extensionFactories: [],
		agentDir: "/tmp/fake-agent-dir",
		sessionFactory: makeAcpSessionFactory(session),
	})
}

async function makeReadyAgent(session: FakeAgentSession) {
	const agent = makeAgent(session)
	await agent.initialize({ protocolVersion: 1 })
	await agent.newSession({ cwd: "/tmp", mcpServers: [] })
	return agent
}

describe("KimchiAcpAgent extMethod compact", () => {
	it("compacts the session and returns the result fields", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = await makeReadyAgent(session)

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.compact, { sessionId: "sess-1" })

		expect(result).toEqual({
			status: "completed",
			summary: "compacted summary",
			tokensBefore: 12_000,
			firstKeptEntryId: "entry-42",
		})
		expect(session.compact).toHaveBeenCalledWith(undefined, false)
	})

	it("forwards instructions and force to session.compact", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = await makeReadyAgent(session)

		await agent.extMethod(AVAILABLE_EXT_METHODS.compact, {
			sessionId: "sess-1",
			instructions: "keep the API design section",
			force: true,
		})

		expect(session.compact).toHaveBeenCalledWith("keep the API design section", true)
	})

	it("maps the cancellation rejection to status cancelled", async () => {
		const session = new FakeAgentSession("sess-1")
		session.compact.mockRejectedValueOnce(new Error("Compaction cancelled"))
		const agent = await makeReadyAgent(session)

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.compact, { sessionId: "sess-1" })

		expect(result).toEqual({ status: "cancelled", error: "Compaction cancelled" })
	})

	it("maps routine no-op guards to status failed with the message in error", async () => {
		const session = new FakeAgentSession("sess-1")
		session.compact.mockRejectedValue(new Error("Nothing to compact (session too small)"))
		const agent = await makeReadyAgent(session)

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.compact, { sessionId: "sess-1" })

		expect(result).toEqual({ status: "failed", error: "Nothing to compact (session too small)" })
	})

	it("rejects while a prompt turn is active", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = await makeReadyAgent(session)

		const promptPromise = agent.prompt({ sessionId: "sess-1", prompt: [{ type: "text", text: "do work" }] })
		// entry.turn is set synchronously in prompt(), but the call above is async
		// — flush the queue so the turn context exists before compact arrives.
		await Promise.resolve()

		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.compact, { sessionId: "sess-1" })).rejects.toThrow(
			/prompt turn is in progress/,
		)
		expect(session.compact).not.toHaveBeenCalled()

		session.finishTurn()
		await promptPromise
	})

	it("rejects invalid params and unknown sessions", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = await makeReadyAgent(session)

		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.compact, {})).rejects.toThrow(/sessionId is required/)
		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.compact, { sessionId: "sess-1", force: "yes" })).rejects.toThrow(
			/force must be a boolean/,
		)
		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.compact, { sessionId: "nope" })).rejects.toThrow(
			/unknown sessionId/,
		)
	})

	it("rejects unexpected compact failures as errors rather than relabeling them", async () => {
		const session = new FakeAgentSession("sess-1")
		session.compact.mockRejectedValue(new Error("summarizer exploded"))
		const agent = await makeReadyAgent(session)

		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.compact, { sessionId: "sess-1" })).rejects.toThrow(
			/summarizer exploded/,
		)
	})
})

describe("KimchiAcpAgent extMethod compact_abort", () => {
	it("aborts an in-flight compaction", async () => {
		const session = new FakeAgentSession("sess-1")
		session.isCompacting = true
		const agent = await makeReadyAgent(session)

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.compact_abort, { sessionId: "sess-1" })

		expect(result).toEqual({ status: "aborted" })
		expect(session.abortCompaction).toHaveBeenCalledTimes(1)
	})

	it("resolves notCompacting when no compaction is in flight", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = await makeReadyAgent(session)

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.compact_abort, { sessionId: "sess-1" })

		expect(result).toEqual({ status: "notCompacting" })
		expect(session.abortCompaction).not.toHaveBeenCalled()
	})

	it("rejects invalid params and unknown sessions", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = await makeReadyAgent(session)

		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.compact_abort, {})).rejects.toThrow(/sessionId is required/)
		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.compact_abort, { sessionId: "nope" })).rejects.toThrow(
			/unknown sessionId/,
		)
	})
})

describe("KimchiAcpAgent prompt gating during compaction", () => {
	it("rejects a prompt while the session is compacting", async () => {
		const session = new FakeAgentSession("sess-1")
		session.isCompacting = true
		const agent = await makeReadyAgent(session)

		await expect(agent.prompt({ sessionId: "sess-1", prompt: [{ type: "text", text: "hello" }] })).rejects.toThrow(
			/compaction is in progress/,
		)
	})

	it("accepts a prompt again once compaction has ended", async () => {
		const session = new FakeAgentSession("sess-1")
		session.isCompacting = false
		const agent = await makeReadyAgent(session)

		const promptPromise = agent.prompt({ sessionId: "sess-1", prompt: [{ type: "text", text: "hello" }] })
		await Promise.resolve()
		session.finishTurn()
		expect(await promptPromise).toEqual({ stopReason: "end_turn" })
	})
})
