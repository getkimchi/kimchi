import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { appendTranscriptGapMarker } from "./session-recovery.js"

describe("appendTranscriptGapMarker", () => {
	const dirs: string[] = []
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
	})

	function makeOutputFile(entries: string[]): string {
		const dir = mkdtempSync(join(tmpdir(), "gap-marker-test-"))
		dirs.push(dir)
		const file = join(dir, "output.jsonl")
		writeFileSync(file, `${entries.join("\n")}\n`, { mode: 0o600 })
		return file
	}

	it("appends a local-schema assistant entry carrying the note and derived identity", async () => {
		const file = makeOutputFile([
			JSON.stringify({
				isSidechain: true,
				agentId: "agent-1",
				type: "user",
				message: { role: "user", content: [] },
				timestamp: "2026-09-08T00:00:00.000Z",
				cwd: "/repo",
			}),
		])

		await appendTranscriptGapMarker(file, "disconnect window — test note")

		const lines = readFileSync(file, "utf-8")
			.split("\n")
			.filter((l) => l.trim().startsWith("{"))
		expect(lines).toHaveLength(2)
		const marker = JSON.parse(lines[1] ?? "") as {
			isSidechain: boolean
			agentId: string
			type: string
			cwd: string
			timestamp: string
			message: { role: string; content: Array<{ type: string; text: string }> }
		}
		expect(marker.isSidechain).toBe(true)
		expect(marker.agentId).toBe("agent-1")
		expect(marker.type).toBe("assistant")
		expect(marker.cwd).toBe("/repo")
		expect(marker.message.role).toBe("assistant")
		expect(marker.message.content[0]?.type).toBe("text")
		expect(marker.message.content[0]?.text).toContain("[Transcript gap: disconnect window — test note]")
		expect(typeof marker.timestamp).toBe("string")
	})

	it("creates the file when it does not exist, with empty identity fields", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gap-marker-test-"))
		dirs.push(dir)
		const file = join(dir, "missing.jsonl")
		expect(existsSync(file)).toBe(false)

		await appendTranscriptGapMarker(file, "no local entries")

		const marker = JSON.parse(readFileSync(file, "utf-8").trim()) as {
			agentId: string
			cwd: string
			message: { content: Array<{ text: string }> }
		}
		expect(marker.agentId).toBe("")
		expect(marker.cwd).toBe("")
		expect(marker.message.content[0]?.text).toContain("no local entries")
	})
})
