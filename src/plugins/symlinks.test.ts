import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { linkPlugin, unlinkPlugin } from "./symlinks.js"

describe("linkPlugin", () => {
	let tempDir: string
	let sourceDir: string
	let claudeHome: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-symlinks-test-"))
		sourceDir = join(tempDir, "source")
		claudeHome = join(tempDir, "claude-home")

		// Create the source directories that the plugin exposes
		mkdirSync(join(sourceDir, "commands"), { recursive: true })
		mkdirSync(join(sourceDir, "agents"), { recursive: true })

		// Create the parent dirs inside claudeHome that will hold the symlinks
		mkdirSync(join(claudeHome, "commands"), { recursive: true })
		mkdirSync(join(claudeHome, "agents"), { recursive: true })
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	// WI-6: happy path
	it("creates symlinks for both commands and agents directories", () => {
		const result = linkPlugin({ name: "my-plugin", sourceDir, claudeHome })

		expect(result).toEqual({ ok: true, created: 2, replaced: 0, skipped: 0 })

		const commandsLink = join(claudeHome, "commands", "my-plugin")
		const agentsLink = join(claudeHome, "agents", "my-plugin")

		expect(lstatSync(commandsLink).isSymbolicLink()).toBe(true)
		expect(lstatSync(agentsLink).isSymbolicLink()).toBe(true)

		expect(readlinkSync(commandsLink)).toBe(join(sourceDir, "commands"))
		expect(readlinkSync(agentsLink)).toBe(join(sourceDir, "agents"))
	})

	// WI-7: idempotent re-link
	it("is idempotent — calling linkPlugin twice skips existing correct symlinks", () => {
		linkPlugin({ name: "my-plugin", sourceDir, claudeHome })
		const result = linkPlugin({ name: "my-plugin", sourceDir, claudeHome })

		expect(result).toEqual({ ok: true, created: 0, replaced: 0, skipped: 2 })

		// Symlink targets are unchanged
		const commandsLink = join(claudeHome, "commands", "my-plugin")
		const agentsLink = join(claudeHome, "agents", "my-plugin")
		expect(readlinkSync(commandsLink)).toBe(join(sourceDir, "commands"))
		expect(readlinkSync(agentsLink)).toBe(join(sourceDir, "agents"))
	})

	// WI-8: refuses to clobber a real directory
	it("refuses to replace a real directory with a symlink and returns exists-not-symlink", () => {
		// Pre-create a real directory at the commands symlink target location
		mkdirSync(join(claudeHome, "commands", "my-plugin"), { recursive: true })

		const result = linkPlugin({ name: "my-plugin", sourceDir, claudeHome })

		expect(result).toEqual({
			ok: false,
			reason: "exists-not-symlink",
			path: join(claudeHome, "commands", "my-plugin"),
		})

		// The pre-existing real directory must still be intact
		expect(lstatSync(join(claudeHome, "commands", "my-plugin")).isDirectory()).toBe(true)
		expect(lstatSync(join(claudeHome, "commands", "my-plugin")).isSymbolicLink()).toBe(false)
	})

	it("rejects names with path traversal characters", () => {
		const result = linkPlugin({ name: "../../etc/passwd", sourceDir, claudeHome })
		expect(result).toEqual({ ok: false, reason: "invalid-name", path: "../../etc/passwd" })
	})

	// WI-9: replaces a stale symlink pointing elsewhere
	it("replaces a stale symlink pointing at a different path", () => {
		// Pre-create a symlink pointing at a stale target
		symlinkSync("/tmp/stale-target", join(claudeHome, "commands", "my-plugin"))

		const result = linkPlugin({ name: "my-plugin", sourceDir, claudeHome })

		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error("expected ok")
		expect(result.replaced).toBeGreaterThanOrEqual(1)

		// The symlink now points at the correct source
		expect(readlinkSync(join(claudeHome, "commands", "my-plugin"))).toBe(join(sourceDir, "commands"))
	})
})

describe("unlinkPlugin", () => {
	let tempDir: string
	let sourceDir: string
	let claudeHome: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-symlinks-test-"))
		sourceDir = join(tempDir, "source")
		claudeHome = join(tempDir, "claude-home")

		mkdirSync(join(sourceDir, "commands"), { recursive: true })
		mkdirSync(join(sourceDir, "agents"), { recursive: true })
		mkdirSync(join(claudeHome, "commands"), { recursive: true })
		mkdirSync(join(claudeHome, "agents"), { recursive: true })
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	// WI-10: removes symlinks after linkPlugin
	it("removes both symlinks after a successful linkPlugin", () => {
		linkPlugin({ name: "my-plugin", sourceDir, claudeHome })

		const result = unlinkPlugin({ name: "my-plugin", claudeHome })

		expect(result).toEqual({ ok: true, removed: 2 })

		expect(existsSync(join(claudeHome, "commands", "my-plugin"))).toBe(false)
		expect(existsSync(join(claudeHome, "agents", "my-plugin"))).toBe(false)
	})

	// WI-10: tolerates absent symlinks (nothing was ever linked)
	it("tolerates absent symlinks and returns removed: 0 without throwing", () => {
		const result = unlinkPlugin({ name: "never-linked", claudeHome })

		expect(result).toEqual({ ok: true, removed: 0 })
	})

	// WI-10: refuses to remove a real directory
	it("refuses to remove a real directory and returns exists-not-symlink", () => {
		// Pre-create a real directory at the commands symlink location
		mkdirSync(join(claudeHome, "commands", "my-plugin"), { recursive: true })

		const result = unlinkPlugin({ name: "my-plugin", claudeHome })

		expect(result).toEqual({
			ok: false,
			reason: "exists-not-symlink",
			path: join(claudeHome, "commands", "my-plugin"),
		})

		// The real directory must NOT have been deleted
		expect(lstatSync(join(claudeHome, "commands", "my-plugin")).isDirectory()).toBe(true)
	})
})
