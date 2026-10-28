// ACP integration — rating a conversation after a CLI restart (the Studio
// post-restart flow). One ACP process serves one app run: on restart the
// CLI's live registry is empty and Studio reopens conversations from their
// JSONL logs. The new flow: Studio ensures the session (ACP `session/load`,
// registering it live) before submitting, and the harness arms the rating
// window at session start from the log's settled-unrated tail — so the
// rating records into the same log the second process never saw live.

import { readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AVAILABLE_EXT_METHODS } from "../../../src/modes/acp/capabilities.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, waitForSessionUpdate } from "./support/scenarios.js"

function rate(
	fixture: AcpFixture,
	sessionId: string,
	params: { sentiment: string; reason?: string },
): Promise<unknown> {
	return fixture.conn.extMethod(AVAILABLE_EXT_METHODS.feedback, {
		sessionId,
		action: "rate_response",
		...params,
	})
}

/** The session log the CLI wrote for this session, wherever it sits under
 * the agent dir's per-project session store. */
function sessionLogFile(homeDir: string, sessionId: string): string {
	const sessionsRoot = join(homeDir, ".config", "kimchi", "harness", "sessions")
	for (const dir of readdirSync(sessionsRoot)) {
		for (const file of readdirSync(join(sessionsRoot, dir))) {
			if (file.endsWith(`_${sessionId}.jsonl`)) return join(sessionsRoot, dir, file)
		}
	}
	throw new Error(`no session log for ${sessionId} under ${sessionsRoot}`)
}

describe("ACP integration — rating after a CLI restart", () => {
	it(
		"rates the persisted session's settled reply in a fresh CLI process",
		async () => {
			// Process 1: settle a turn, then die. Its log is the only trace.
			const first = await startAcpFixture({
				artifactName: "feedback-restart-first",
				responses: [{ stream: ["First answer."] }],
				pretrustWorkDir: true,
				keepDirsOnStop: true,
			})
			let sessionId: string
			try {
				sessionId = await newSession(first, first.workDir)
				const promptResult = await first.conn.prompt({
					sessionId,
					prompt: [{ type: "text", text: "hello" }],
				})
				expect(promptResult.stopReason).toBe("end_turn")
			} finally {
				await first.stop()
			}
			const { homeDir, workDir } = first

			// Process 2: same session store, fresh CLI. Studio's ensureSession
			// equivalent registers the session live; the harness derives the
			// rating state from the log at session start.
			const second = await startAcpFixture({
				artifactName: "feedback-restart-second",
				responses: [],
				homeDirOverride: homeDir,
				workDirOverride: workDir,
				pretrustWorkDir: true,
			})
			try {
				await second.conn.loadSession({ sessionId, cwd: workDir, mcpServers: [] })

				const result = await rate(second, sessionId, { sentiment: "positive", reason: "Solved my task" })
				expect(result).toEqual({ status: "recorded" })

				// The rating landed in the same log process 1 wrote.
				const log = readFileSync(sessionLogFile(homeDir, sessionId), "utf-8")
				const summary = log
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: unknown })
					.find((entry) => entry.type === "custom" && entry.customType === "feedback-summary")
				expect(summary?.data).toEqual({ sentiment: "positive", reason: "Solved my task" })

				// One rating per settled response — the window was consumed.
				await expect(rate(second, sessionId, { sentiment: "negative" })).rejects.toMatchObject({ code: -32600 })
			} finally {
				await second.stop()
				rmSync(homeDir, { recursive: true, force: true })
				rmSync(workDir, { recursive: true, force: true })
			}
		},
		STARTUP_TIMEOUT_MS * 2 + 60_000,
	)

	it(
		"a cancelled reply is not rateable after a CLI restart, but the next settle is",
		async () => {
			// Process 1: a turn cancelled mid-response — the partial reply persists
			// with stopReason "aborted".
			const first = await startAcpFixture({
				artifactName: "feedback-restart-cancelled-first",
				responses: [{ stream: ["Still ", "working ", "on ", "it."], delayMs: 400 }],
				pretrustWorkDir: true,
				keepDirsOnStop: true,
			})
			let sessionId: string
			try {
				sessionId = await newSession(first, first.workDir)
				const promptPromise = first.conn.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] })
				await waitForSessionUpdate(first, sessionId, (u) => u.sessionUpdate === "agent_message_chunk")
				await first.conn.cancel({ sessionId })
				const promptResult = await promptPromise
				expect(promptResult.stopReason).toBe("cancelled")
			} finally {
				await first.stop()
			}
			const { homeDir, workDir } = first

			// Process 2: the aborted tail must not arm the window — byte-identical
			// rejection — but a fresh settle afterwards is rateable as always.
			const second = await startAcpFixture({
				artifactName: "feedback-restart-cancelled-second",
				responses: [{ stream: ["Recovered answer."] }],
				homeDirOverride: homeDir,
				workDirOverride: workDir,
				pretrustWorkDir: true,
			})
			try {
				await second.conn.loadSession({ sessionId, cwd: workDir, mcpServers: [] })
				await expect(rate(second, sessionId, { sentiment: "positive" })).rejects.toMatchObject({
					code: -32600,
					message: "Invalid request: no settled response to rate",
				})

				// The log names the reason: the tail reply persisted "aborted".
				const entries = readFileSync(sessionLogFile(homeDir, sessionId), "utf-8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string } })
				const assistantEntries = entries.filter(
					(entry) => entry.type === "message" && entry.message?.role === "assistant",
				)
				expect(assistantEntries.at(-1)?.message?.stopReason).toBe("aborted")

				const next = await second.conn.prompt({ sessionId, prompt: [{ type: "text", text: "try again" }] })
				expect(next.stopReason).toBe("end_turn")
				const result = await rate(second, sessionId, { sentiment: "positive", reason: "Recovered" })
				expect(result).toEqual({ status: "recorded" })
			} finally {
				await second.stop()
				rmSync(homeDir, { recursive: true, force: true })
				rmSync(workDir, { recursive: true, force: true })
			}
		},
		STARTUP_TIMEOUT_MS * 2 + 60_000,
	)

	it(
		"an errored reply is not rateable after a CLI restart",
		async () => {
			// Process 1: a turn that dies on a provider error — the reply persists
			// with stopReason "error".
			const first = await startAcpFixture({
				artifactName: "feedback-restart-errored-first",
				responses: [{ streamError: "provider exploded" }],
				pretrustWorkDir: true,
				keepDirsOnStop: true,
			})
			let sessionId: string
			try {
				sessionId = await newSession(first, first.workDir)
				// A terminal provider error fails the prompt call on the wire.
				await expect(first.conn.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] })).rejects.toThrow()
			} finally {
				await first.stop()
			}
			const { homeDir, workDir } = first

			// Process 2: the errored tail must not arm the window.
			const second = await startAcpFixture({
				artifactName: "feedback-restart-errored-second",
				responses: [],
				homeDirOverride: homeDir,
				workDirOverride: workDir,
				pretrustWorkDir: true,
			})
			try {
				await second.conn.loadSession({ sessionId, cwd: workDir, mcpServers: [] })
				await expect(rate(second, sessionId, { sentiment: "positive" })).rejects.toMatchObject({
					code: -32600,
					message: "Invalid request: no settled response to rate",
				})

				// The log names the reason: the tail reply persisted "error".
				const entries = readFileSync(sessionLogFile(homeDir, sessionId), "utf-8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string } })
				const assistantEntries = entries.filter(
					(entry) => entry.type === "message" && entry.message?.role === "assistant",
				)
				expect(assistantEntries.at(-1)?.message?.stopReason).toBe("error")
			} finally {
				await second.stop()
				rmSync(homeDir, { recursive: true, force: true })
				rmSync(workDir, { recursive: true, force: true })
			}
		},
		STARTUP_TIMEOUT_MS * 2 + 60_000,
	)

	it(
		"a fresh CLI process with no persisted log keeps rejecting unknown ids",
		async () => {
			const fixture = await startAcpFixture({
				artifactName: "feedback-restart-unknown",
				responses: [],
			})
			try {
				await expect(
					rate(fixture, "00000000-0000-4000-8000-000000000000", { sentiment: "positive" }),
				).rejects.toMatchObject({ code: -32602 })
			} finally {
				await fixture.stop()
			}
		},
		STARTUP_TIMEOUT_MS,
	)
})
