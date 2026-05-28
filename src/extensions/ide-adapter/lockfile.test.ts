import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { findMatchingLockfile, getLockfileDir, isProcessAlive, parseLockfile, scanLockfiles } from "./lockfile.js"

describe("lockfile", () => {
	describe("getLockfileDir", () => {
		it("returns the default dot-config path when env is not set", () => {
			const original = process.env.KIMCHI_IDE_LOCKFILE_DIR
			Reflect.deleteProperty(process.env, "KIMCHI_IDE_LOCKFILE_DIR")
			const dir = getLockfileDir()
			expect(dir).toMatch(/\.config[/\\]kimchi[/\\]ide/)
			if (original !== undefined) {
				process.env.KIMCHI_IDE_LOCKFILE_DIR = original
			}
		})

		it("respects KIMCHI_IDE_LOCKFILE_DIR override", () => {
			const original = process.env.KIMCHI_IDE_LOCKFILE_DIR
			process.env.KIMCHI_IDE_LOCKFILE_DIR = "/tmp/test-ide"
			const dir = getLockfileDir()
			expect(dir).toBe("/tmp/test-ide")
			if (original !== undefined) {
				process.env.KIMCHI_IDE_LOCKFILE_DIR = original
			} else {
				Reflect.deleteProperty(process.env, "KIMCHI_IDE_LOCKFILE_DIR")
			}
		})
	})

	describe("scanLockfiles", () => {
		it("returns empty array for a non-existent directory", () => {
			const result = scanLockfiles("/nonexistent/path/12345")
			expect(result).toEqual([])
		})
	})

	describe("parseLockfile", () => {
		it("parses a valid lockfile", () => {
			const data = {
				port: 12345,
				pid: 999,
				ideName: "IntelliJ IDEA",
				ideVersion: "2024.1",
				transport: "ws",
				workspaceFolders: ["/path/to/project"],
				authToken: "abc-123",
			}
			const dir = mkdtempSync(join(tmpdir(), "ide-adapter-"))
			const path = join(dir, "12345.lock")
			writeFileSync(path, JSON.stringify(data))
			const parsed = parseLockfile(path)
			expect(parsed).toEqual(data)
		})

		it("returns null for invalid JSON", () => {
			const dir = mkdtempSync(join(tmpdir(), "ide-adapter-"))
			const path = join(dir, "bad.lock")
			writeFileSync(path, "not json")
			expect(parseLockfile(path)).toBeNull()
		})

		it("returns null for missing required fields", () => {
			const dir = mkdtempSync(join(tmpdir(), "ide-adapter-"))
			const p1 = join(dir, "empty.lock")
			writeFileSync(p1, JSON.stringify({}))
			expect(parseLockfile(p1)).toBeNull()

			const p2 = join(dir, "partial.lock")
			writeFileSync(p2, JSON.stringify({ port: 123 }))
			expect(parseLockfile(p2)).toBeNull()
		})
	})

	describe("isProcessAlive", () => {
		it("returns true for current process PID", () => {
			expect(isProcessAlive(process.pid)).toBe(true)
		})

		it("returns false for a non-existent PID", () => {
			expect(isProcessAlive(999999)).toBe(false)
		})
	})

	describe("findMatchingLockfile", () => {
		it("matches exact workspace folder", () => {
			const lockfiles = [
				{
					port: 1,
					pid: process.pid,
					ideName: "a",
					ideVersion: "1",
					transport: "ws",
					workspaceFolders: ["/home/user/project"],
					authToken: "t1",
				},
			]
			const match = findMatchingLockfile(lockfiles, "/home/user/project")
			expect(match).toBeDefined()
			expect(match?.port).toBe(1)
		})

		it("matches nested cwd", () => {
			const lockfiles = [
				{
					port: 1,
					pid: process.pid,
					ideName: "a",
					ideVersion: "1",
					transport: "ws",
					workspaceFolders: ["/home/user/project"],
					authToken: "t1",
				},
			]
			const match = findMatchingLockfile(lockfiles, "/home/user/project/src")
			expect(match).toBeDefined()
			expect(match?.port).toBe(1)
		})

		it("returns undefined when nothing matches and no alive pids", () => {
			const lockfiles = [
				{
					port: 1,
					pid: 999999,
					ideName: "a",
					ideVersion: "1",
					transport: "ws",
					workspaceFolders: ["/home/user/project"],
					authToken: "t1",
				},
			]
			const match = findMatchingLockfile(lockfiles, "/home/user/project")
			expect(match).toBeUndefined()
		})
	})
})
