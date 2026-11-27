import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ReviewSessionStore } from "./sessions.js"

describe("review session files", () => {
	let sandbox: string

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "review-session-files-"))
	})

	afterEach(() => {
		rmSync(sandbox, { recursive: true, force: true })
	})

	it("creates a private directory and never reuses a writer's earlier path", async () => {
		const outputDir = join(sandbox, "review-output")
		const store = await ReviewSessionStore.create(outputDir)
		if (process.platform !== "win32") expect(statSync(store.directory).mode & 0o777).toBe(0o700)
		const sessionsDir = store.directory
		expect(sessionsDir).toBe(join(realpathSync(outputDir), "sessions"))

		const first = await store.allocate("spec")
		const second = await store.allocate("spec")
		const verifier = await store.allocate("reconciliation")
		expect(first).toEqual({
			sessionFile: join(sessionsDir, "spec.jsonl"),
			sessionDir: sessionsDir,
		})
		expect(second.sessionFile).toBe(join(sessionsDir, "spec.2.jsonl"))
		expect(verifier.sessionFile).toBe(join(sessionsDir, "reconciliation.jsonl"))

		writeFileSync(first.sessionFile, "first transcript\n")
		writeFileSync(second.sessionFile, "second transcript\n")
		const resumed = await ReviewSessionStore.create(outputDir)
		expect((await resumed.allocate("spec")).sessionFile).toBe(join(sessionsDir, "spec.3.jsonl"))
		expect(readFileSync(first.sessionFile, "utf8")).toBe("first transcript\n")
		expect(readFileSync(second.sessionFile, "utf8")).toBe("second transcript\n")

		await store.makePrivate(first.sessionFile)
		if (process.platform !== "win32") expect(statSync(first.sessionFile).mode & 0o777).toBe(0o600)
		await store.makePrivate(join(sessionsDir, "missing.jsonl"))
	})
})
