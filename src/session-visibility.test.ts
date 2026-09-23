import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { INTERNAL_SESSION_ENTRY, isInternalSession } from "./session-visibility.js"

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function savedSession(marker: boolean, name: string, prompt = "Ordinary work") {
	const directory = mkdtempSync(join(tmpdir(), "kimchi-session-visibility-"))
	directories.push(directory)
	const timestamp = new Date().toISOString()
	const entries = [
		{
			type: "session",
			version: 3,
			id: "child",
			cwd: directory,
			timestamp,
			parentSession: join(directory, "parent.jsonl"),
		},
		...(marker ? [{ type: "custom", id: "marker", timestamp, customType: INTERNAL_SESSION_ENTRY }] : []),
		{ type: "session_info", id: "name", timestamp, name },
		{ type: "message", id: "message", timestamp, message: { role: "user", content: prompt, timestamp: Date.now() } },
	]
	writeFileSync(join(directory, "child.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"))
	const sessions = await SessionManager.list(directory, directory)
	expect(sessions).toHaveLength(1)
	return sessions[0]
}

describe("internal session classification", () => {
	it("recognizes the persisted marker even after renaming", async () => {
		expect(await isInternalSession(await savedSession(true, "A renamed session"))).toBe(true)
	})
	it("preserves ordinary branches with an evaluator-like name", async () => {
		expect(await isInternalSession(await savedSession(false, "Ferment V2 evaluator"))).toBe(false)
	})
	it("recognizes legacy evaluator sessions by their reserved name and prompt structure", async () => {
		const session = await savedSession(
			false,
			"Ferment V2 evaluator",
			"Objective:\nFix it\n\nCurrent Todo state:\n[]\n\nDurable Ferment V2 lessons:\n(none)",
		)
		expect(await isInternalSession(session)).toBe(true)
	})
	it("does not hide an unreadable or concurrently removed session", async () => {
		const session = await savedSession(true, "Internal")
		rmSync(session.path)
		expect(await isInternalSession(session)).toBe(false)
	})
})
