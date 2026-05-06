/**
 * WI-19: win32 EPERM fallback tests.
 * These live in a separate file because vi.mock("node:fs") is hoisted
 * and would affect the entire module, so they need their own module scope.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		symlinkSync: vi.fn(actual.symlinkSync),
	}
})

import * as fs from "node:fs"
import { linkPlugin } from "./symlinks.js"

describe("linkPlugin win32 EPERM fallback", () => {
	let tempDir: string
	let sourceDir: string
	let claudeHome: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-symlinks-eperm-test-"))
		sourceDir = join(tempDir, "source")
		claudeHome = join(tempDir, "claude-home")

		mkdirSync(join(sourceDir, "commands"), { recursive: true })
		mkdirSync(join(sourceDir, "agents"), { recursive: true })
		mkdirSync(join(claudeHome, "commands"), { recursive: true })
		mkdirSync(join(claudeHome, "agents"), { recursive: true })

		vi.mocked(fs.symlinkSync).mockRestore()
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		vi.mocked(fs.symlinkSync).mockRestore()
	})

	// WI-19: returns symlink-permission when symlinkSync throws EPERM (Windows non-elevated)
	it("returns symlink-permission error when symlinkSync throws EPERM", () => {
		vi.mocked(fs.symlinkSync).mockImplementation(() => {
			const err = Object.assign(new Error("EPERM: operation not permitted, symlink"), {
				code: "EPERM",
			})
			throw err
		})

		const result = linkPlugin({ name: "my-plugin", sourceDir, claudeHome })

		expect(result).toEqual({
			ok: false,
			reason: "symlink-permission",
			path: join(claudeHome, "commands", "my-plugin"),
		})
	})

	// WI-19: re-throws non-EPERM errors from symlinkSync
	it("re-throws errors from symlinkSync that are not EPERM", () => {
		vi.mocked(fs.symlinkSync).mockImplementation(() => {
			const err = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
			throw err
		})

		expect(() => linkPlugin({ name: "my-plugin", sourceDir, claudeHome })).toThrow("EACCES")
	})
})
