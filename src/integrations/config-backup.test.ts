import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "@clack/prompts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { backupToolConfig } from "./config-backup.js"

vi.mock("node:crypto", () => ({ randomUUID: vi.fn() }))

describe("backupToolConfig", () => {
	let directory: string
	let path: string

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "kimchi-backup-test-"))
		path = join(directory, "settings.json")
		vi.mocked(randomUUID).mockReturnValue("00000000-0000-0000-0000-000000000001")
		vi.spyOn(log, "info").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		rmSync(directory, { recursive: true, force: true })
	})

	it("preserves exact bytes in a private file, leaving the original untouched", () => {
		const original = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0d, 0x0a])
		writeFileSync(path, original, { mode: 0o644 })
		const backup = backupToolConfig(path)
		expect(backup).toBeDefined()
		if (!backup) throw new Error("Expected backup")
		expect(readFileSync(backup)).toEqual(original)
		expect(statSync(backup).mode & 0o777).toBe(0o600)
		expect(readFileSync(path)).toEqual(original)
	})

	it("skips files that do not exist", () => {
		expect(backupToolConfig(path)).toBeUndefined()
		expect(existsSync(path)).toBe(false)
		expect(log.info).not.toHaveBeenCalled()
	})

	it("explains read failures before creating a backup", () => {
		mkdirSync(path)
		expect(() => backupToolConfig(path)).toThrow(
			`Could not read ${path} to create a backup (EISDIR). No configuration changes written.`,
		)
		expect(readdirSync(directory)).toEqual(["settings.json"])
		expect(log.info).not.toHaveBeenCalled()
	})

	it("never overwrites an earlier backup, even if its name collides", () => {
		writeFileSync(path, "original")
		const backup = backupToolConfig(path)
		if (!backup) throw new Error("Expected backup")
		writeFileSync(path, "new settings")
		expect(() => backupToolConfig(path)).toThrow(/Could not create backup for .+: EEXIST/)
		expect(readFileSync(backup, "utf8")).toBe("original")
		expect(readFileSync(path, "utf8")).toBe("new settings")
	})

	it("keeps previous backups on subsequent runs", () => {
		writeFileSync(path, "original")
		const first = backupToolConfig(path)
		vi.mocked(randomUUID).mockReturnValue("00000000-0000-0000-0000-000000000002")
		writeFileSync(path, "updated")
		const second = backupToolConfig(path)
		if (!first || !second) throw new Error("Expected backups")
		expect(first).not.toBe(second)
		expect(readFileSync(first, "utf8")).toBe("original")
		expect(readFileSync(second, "utf8")).toBe("updated")
	})
})
