import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createOutputFilePath } from "./output-file.js"

describe("createOutputFilePath", () => {
	let tmp: string

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "agent-output-file-"))
	})

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true })
	})

	it("uses a persisted root when provided", () => {
		const path = createOutputFilePath("/app", "agent-1", "session-1", tmp)

		expect(path).toBe(join(tmp, "agent-outputs", "session-1", "tasks", "agent-1.output"))
		expect(existsSync(join(tmp, "agent-outputs", "session-1", "tasks"))).toBe(true)
	})

	it("falls back to the temp-root layout when no persisted root is available", () => {
		const path = createOutputFilePath("/app", "agent-1", "session-1")

		expect(path).toContain("kimchi-agents-")
		expect(path).toContain(join("app", "session-1", "tasks", "agent-1.output"))
	})
})
