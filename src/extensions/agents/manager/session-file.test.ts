import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getSessionRoleInfo } from "../../../session-visibility.js"
import { prepareAgentSessionFile } from "./session-file.js"

describe("prepareAgentSessionFile", () => {
	let tmp: string

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "agent-session-file-"))
	})

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true })
	})

	it("returns undefined when the parent session is not persisted", () => {
		expect(prepareAgentSessionFile(tmp, undefined, "/app", "Explore")).toBeUndefined()
		expect(prepareAgentSessionFile("", "/logs/agent/sessions/main.jsonl", "/app", "Explore")).toBeUndefined()
	})

	it("writes a child session header with a parentSession backlink", () => {
		const parentFile = join(tmp, "main.jsonl")
		const fixedId = "01928374-5565-7abc-8def-123456789abc"
		const fixedTs = new Date("2026-05-12T10:20:30.400Z")

		const prepared = prepareAgentSessionFile(
			tmp,
			parentFile,
			"/app",
			"Explore",
			() => fixedId,
			() => fixedTs,
		)

		expect(prepared?.sessionId).toBe(fixedId)
		expect(prepared?.sessionFile).toBe(join(tmp, `2026-05-12T10-20-30-400Z_${fixedId}.jsonl`))

		const lines = readFileSync(prepared?.sessionFile ?? "", "utf8")
			.trimEnd()
			.split("\n")
		expect(lines).toHaveLength(2)
		expect(JSON.parse(lines[0])).toEqual({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: fixedId,
			timestamp: fixedTs.toISOString(),
			cwd: "/app",
			parentSession: parentFile,
		})
	})

	it("retains the agent type after the child runs and is renamed", async () => {
		const prepared = prepareAgentSessionFile(tmp, join(tmp, "main.jsonl"), tmp, "Explorer")
		expect(prepared).toBeDefined()
		if (!prepared) throw new Error("Expected a persisted child")
		const manager = SessionManager.open(prepared.sessionFile, tmp)
		manager.appendSessionInfo("Find the retry boundary")
		manager.appendMessage({ role: "user", content: "Investigate ".repeat(10_000), timestamp: Date.now() })
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Found it" }],
			api: "openai-completions",
			provider: "fake",
			model: "basic",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		})
		const [saved] = await SessionManager.list(tmp, tmp)
		expect(saved.name).toBe("Find the retry boundary")
		expect(await getSessionRoleInfo(saved)).toEqual({ kind: "subagent", name: "Explorer" })
	})

	it("writes private session files", () => {
		const prepared = prepareAgentSessionFile(tmp, join(tmp, "main.jsonl"), "/app", "Explore")
		const mode = statSync(prepared?.sessionFile ?? "").mode & 0o777
		expect(mode).toBe(0o600)
	})
})
