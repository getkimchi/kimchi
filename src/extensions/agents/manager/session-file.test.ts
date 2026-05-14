import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
		expect(prepareAgentSessionFile(tmp, undefined, "/app")).toBeUndefined()
		expect(prepareAgentSessionFile("", "/logs/agent/sessions/main.jsonl", "/app")).toBeUndefined()
	})

	it("writes a child session header with a parentSession backlink", () => {
		const parentFile = join(tmp, "main.jsonl")
		const fixedId = "01928374-5565-7abc-8def-123456789abc"
		const fixedTs = new Date("2026-05-12T10:20:30.400Z")

		const prepared = prepareAgentSessionFile(
			tmp,
			parentFile,
			"/app",
			() => fixedId,
			() => fixedTs,
		)

		expect(prepared?.sessionId).toBe(fixedId)
		expect(prepared?.sessionFile).toBe(join(tmp, `2026-05-12T10-20-30-400Z_${fixedId}.jsonl`))

		const lines = readFileSync(prepared?.sessionFile ?? "", "utf8")
			.trimEnd()
			.split("\n")
		expect(lines).toHaveLength(1)
		expect(JSON.parse(lines[0])).toEqual({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: fixedId,
			timestamp: fixedTs.toISOString(),
			cwd: "/app",
			parentSession: parentFile,
		})
	})

	it("writes private session files", () => {
		const prepared = prepareAgentSessionFile(tmp, join(tmp, "main.jsonl"), "/app")
		const mode = statSync(prepared?.sessionFile ?? "").mode & 0o777
		expect(mode).toBe(0o600)
	})
})
