import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TELEPORT_SESSION_FILE_NAME, exportSessionForTeleport } from "./session-export.js"

describe("exportSessionForTeleport", () => {
	let tmpDir: string
	let homeBase: {
		exportToJsonl: (path: string) => string
	}

	beforeEach(() => {
		tmpDir = join(tmpdir(), `kimchi-session-export-test-${Date.now()}`)
		mkdirSync(tmpDir, { recursive: true })
		homeBase = {
			exportToJsonl: (path: string) => {
				const header = JSON.stringify({
					type: "session",
					version: 3,
					id: "test-session-id",
					timestamp: new Date().toISOString(),
					cwd: "/Users/local/project",
				})
				const entry1 = JSON.stringify({
					type: "message",
					id: "e1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "hello" },
				})
				const entry2 = JSON.stringify({
					type: "message",
					id: "e2",
					parentId: "e1",
					timestamp: new Date().toISOString(),
					message: { role: "assistant", content: "hi" },
				})
				const data = `${header}\n${entry1}\n${entry2}\n`
				writeFileSync(path, data, "utf-8")
				return path
			},
		}
	})

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	it("exports the session and rewrites the header cwd to the remote path", () => {
		const result = exportSessionForTeleport({
			homeBase: homeBase as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
			localCwd: "/Users/local/project",
			sandboxDest: "/home/sandbox/project/",
			tmpDir,
		})

		// The exported file should exist in the temp directory.
		const exportedFile = join(result.localDir, TELEPORT_SESSION_FILE_NAME)
		const raw = readFileSync(exportedFile, "utf-8")
		const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)

		expect(lines.length).toBe(3)

		const header = JSON.parse(lines[0])
		expect(header.type).toBe("session")
		expect(header.cwd).toBe("/home/sandbox/project")
		// Other fields should be preserved.
		expect(header.id).toBe("test-session-id")
	})

	it("computes the remote path in the sandbox session directory", () => {
		const result = exportSessionForTeleport({
			homeBase: homeBase as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
			localCwd: "/Users/local/my-app",
			sandboxDest: "/home/sandbox/my-app/",
			tmpDir,
		})

		expect(result.remotePath).toBe(
			"/home/sandbox/.pi/agent/sessions/--home-sandbox-my-app--/teleport-session-export.jsonl",
		)
	})

	it("throws when exportToJsonl produces an empty file", () => {
		const emptyHomeBase = {
			exportToJsonl: (path: string) => {
				writeFileSync(path, "", "utf-8")
				return path
			},
		}

		expect(() =>
			exportSessionForTeleport({
				homeBase: emptyHomeBase as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
				localCwd: "/Users/local/project",
				sandboxDest: "/home/sandbox/project/",
				tmpDir,
			}),
		).toThrow(/empty file/)
	})

	it("throws when the header type is not 'session'", () => {
		const badHomeBase = {
			exportToJsonl: (path: string) => {
				writeFileSync(
					path,
					`${JSON.stringify({ type: "not-a-session" })}
`,
					"utf-8",
				)
				return path
			},
		}

		expect(() =>
			exportSessionForTeleport({
				homeBase: badHomeBase as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
				localCwd: "/Users/local/project",
				sandboxDest: "/home/sandbox/project/",
				tmpDir,
			}),
		).toThrow(/Unexpected session export header type/)
	})
})
