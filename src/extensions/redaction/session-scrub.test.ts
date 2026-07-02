import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scrubSessionFile } from "./session-scrub.js"

const tmpDir = join(import.meta.dirname, "__tmp_session_scrub_test__")
const sessionFile = join(tmpDir, "session.jsonl")

beforeEach(() => {
	mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})

function writeSession(lines: string[]): void {
	writeFileSync(sessionFile, `${lines.join("\n")}\n`)
}

function readSession(): string[] {
	return readFileSync(sessionFile, "utf-8").trim().split("\n").filter(Boolean)
}

describe("scrubSessionFile", () => {
	it("scrubs tool-call args in assistant message entries", () => {
		const secrets = new Set<string>(["secret-api-key-12345678"])
		writeSession([
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							toolCallId: "tc1",
							name: "bash",
							arguments: { command: "curl -H 'Authorization: Bearer secret-api-key-12345678' https://api.example.com" },
						},
					],
				},
			}),
		])

		scrubSessionFile(sessionFile, secrets)

		const lines = readSession()
		const entry = JSON.parse(lines[0])
		const args = entry.message.content[0].arguments
		expect(args.command).toContain("[REDACTED]")
		expect(args.command).not.toContain("secret-api-key-12345678")
	})

	it("scrubs text content in toolResult message entries", () => {
		const secrets = new Set<string>(["secret-api-key-12345678"])
		writeSession([
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "KIMCHI_API_KEY=secret-api-key-12345678" }],
				},
			}),
		])

		scrubSessionFile(sessionFile, secrets)

		const lines = readSession()
		const entry = JSON.parse(lines[0])
		expect(entry.message.content[0].text).toBe("KIMCHI_API_KEY=[REDACTED]")
	})

	it("scrubs GitHub token patterns in tool-call args", () => {
		writeSession([
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							toolCallId: "tc2",
							name: "bash",
							arguments: { command: "echo ghp_0123456789abcdefghij0123456789abcdefghij" },
						},
					],
				},
			}),
		])

		scrubSessionFile(sessionFile, new Set())

		const lines = readSession()
		const entry = JSON.parse(lines[0])
		expect(entry.message.content[0].arguments.command).toBe("echo [REDACTED]")
	})

	it("leaves non-message entries unchanged", () => {
		const compactionEntry = JSON.stringify({
			type: "compactionSummary",
			summary: "Previous conversation about authentication",
		})
		writeSession([compactionEntry])

		scrubSessionFile(sessionFile, new Set(["secret-api-key-12345678"]))

		const lines = readSession()
		expect(lines[0]).toBe(compactionEntry)
	})

	it("handles missing file gracefully", () => {
		expect(() =>
			scrubSessionFile(join(tmpDir, "nonexistent.jsonl"), new Set(["secret-api-key-12345678"])),
		).not.toThrow()
	})

	it("handles malformed JSON lines (passes them through unchanged)", () => {
		const malformedLine = "{ this is not valid json"
		const goodLine = JSON.stringify({
			type: "message",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: "ghp_0123456789abcdefghij0123456789abcdefghij" }],
			},
		})
		writeSession([malformedLine, goodLine])

		scrubSessionFile(sessionFile, new Set())

		const lines = readSession()
		expect(lines[0]).toBe(malformedLine)
		const entry = JSON.parse(lines[1])
		expect(entry.message.content[0].text).toBe("[REDACTED]")
	})

	it("handles empty file", () => {
		writeFileSync(sessionFile, "")
		expect(() => scrubSessionFile(sessionFile, new Set())).not.toThrow()
		expect(readFileSync(sessionFile, "utf-8")).toBe("")
	})

	it("handles file with no secrets (no-op write)", () => {
		const cleanLine = JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "just a normal message" }],
			},
		})
		writeSession([cleanLine])

		scrubSessionFile(sessionFile, new Set())

		const lines = readSession()
		expect(lines[0]).toBe(cleanLine)
	})

	it("handles multiple entries with mixed content", () => {
		const secrets = new Set<string>(["secret-api-key-12345678"])
		writeSession([
			JSON.stringify({ type: "thinkingLevelChange", level: "medium" }),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							toolCallId: "tc1",
							name: "bash",
							arguments: { command: "echo secret-api-key-12345678" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "ghp_0123456789abcdefghij0123456789abcdefghij" }],
				},
			}),
		])

		scrubSessionFile(sessionFile, secrets)

		const lines = readSession()
		// thinkingLevelChange unchanged
		expect(JSON.parse(lines[0]).type).toBe("thinkingLevelChange")
		// assistant tool-call scrubbed
		const assistant = JSON.parse(lines[1])
		expect(assistant.message.content[0].arguments.command).toBe("echo [REDACTED]")
		// toolResult scrubbed
		const toolResult = JSON.parse(lines[2])
		expect(toolResult.message.content[0].text).toBe("[REDACTED]")
	})
})
