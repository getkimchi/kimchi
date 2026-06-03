import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SyncArgs } from "./args.js"
import { resolveSyncPaths } from "./sync.js"

function syncArgs(overrides: Partial<SyncArgs>): SyncArgs {
	return {
		direction: "up",
		workspace: "w",
		source: ".",
		target: ".",
		exclude: [],
		includeIgnored: false,
		delete: false,
		dryRun: false,
		...overrides,
	}
}

describe("resolveSyncPaths — up", () => {
	let cwd: string
	beforeAll(() => {
		cwd = mkdtempSync(join(tmpdir(), "kimchi-sync-test-"))
		mkdirSync(join(cwd, "subdir"), { recursive: true })
		writeFileSync(join(cwd, "file.txt"), "hello", "utf-8")
		writeFileSync(join(cwd, "subdir", "nested.txt"), "world", "utf-8")
	})
	afterAll(() => {
		rmSync(cwd, { recursive: true, force: true })
	})

	it("resolves a relative source against cwd and a relative target against SANDBOX_HOME", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "up", source: "file.txt", target: "project/file.txt" }))
		expect(r.localPath).toBe(join(cwd, "file.txt"))
		expect(r.remotePath).toBe("/home/sandbox/project/file.txt")
		expect(r.isSourceDirectory).toBe(false)
	})

	it("flags a directory source via stat", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "up", source: "subdir", target: "/home/sandbox/sub" }))
		expect(r.isSourceDirectory).toBe(true)
	})

	it("preserves a trailing slash on the local source path", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "up", source: "subdir/", target: "/home/sandbox/sub/" }))
		expect(r.localPath).toBe(join(cwd, "subdir/"))
		expect(r.remotePath).toBe("/home/sandbox/sub/")
		expect(r.isSourceDirectory).toBe(true)
	})

	it("accepts an absolute local source", () => {
		const abs = join(cwd, "file.txt")
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "up", source: abs, target: "/home/sandbox/x" }))
		expect(r.localPath).toBe(abs)
	})

	it("expands ~ on the remote side to SANDBOX_HOME", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "up", source: "file.txt", target: "~/project/file.txt" }))
		expect(r.remotePath).toBe("/home/sandbox/project/file.txt")
	})

	it("expands ~ on the local side to $HOME", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "down", source: "~/x", target: "~/y" }))
		expect(r.localPath).toBe(join(homedir(), "y"))
	})

	it("throws when the local source does not exist", () => {
		expect(() => resolveSyncPaths(cwd, syncArgs({ direction: "up", source: "does-not-exist", target: "/x" }))).toThrow(
			/Local source does not exist/,
		)
	})
})

describe("resolveSyncPaths — down", () => {
	const cwd = "/Users/me/work"

	it("treats a trailing-slash source as a directory", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "down", source: "project/dist/", target: "./dist/" }))
		expect(r.isSourceDirectory).toBe(true)
		expect(r.remotePath).toBe("/home/sandbox/project/dist/")
		expect(r.localPath).toBe(join(cwd, "./dist/"))
	})

	it("treats a no-trailing-slash source as a single file", () => {
		const r = resolveSyncPaths(
			cwd,
			syncArgs({ direction: "down", source: "project/dist/output.tar", target: "./output.tar" }),
		)
		expect(r.isSourceDirectory).toBe(false)
	})

	it("accepts absolute remote source paths", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "down", source: "/var/log/app.log", target: "./app.log" }))
		expect(r.remotePath).toBe("/var/log/app.log")
	})

	it("expands ~ on the remote source to SANDBOX_HOME", () => {
		const r = resolveSyncPaths(cwd, syncArgs({ direction: "down", source: "~/project/dist/", target: "./dist/" }))
		expect(r.remotePath).toBe("/home/sandbox/project/dist/")
		expect(r.isSourceDirectory).toBe(true)
	})
})
