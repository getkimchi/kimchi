import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { atomicInstall, copySupportingFiles } from "./install.js"

const { mocks } = vi.hoisted(() => ({
	mocks: {
		renameSync: null as ((oldPath: string, newPath: string) => void) | null,
	},
}))

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		renameSync: (oldPath: string, newPath: string) => {
			if (mocks.renameSync) {
				return mocks.renameSync(oldPath, newPath)
			}
			return actual.renameSync(oldPath, newPath)
		},
	}
})

describe("copySupportingFiles", () => {
	let srcDir: string
	let dstDir: string

	beforeEach(() => {
		srcDir = mkdtempSync(join(tmpdir(), "kimchi-install-src-"))
		dstDir = mkdtempSync(join(tmpdir(), "kimchi-install-dst-"))
	})

	afterEach(() => {
		rmSync(srcDir, { recursive: true, force: true })
		rmSync(dstDir, { recursive: true, force: true })
	})

	// Regression: copyFileSync's third argument is COPYFILE_* flags (range 0–7),
	// not file mode. Passing stat.mode (e.g. 33188) used to throw
	// "mode is out of range: >= 0 && <= 7" on the very first regular file.
	it("copies a top-level file without throwing on file mode", () => {
		writeFileSync(join(srcDir, "config.json"), '{"hello":"world"}')

		expect(() => copySupportingFiles(srcDir, dstDir)).not.toThrow()
		expect(readFileSync(join(dstDir, "config.json"), "utf-8")).toBe('{"hello":"world"}')
	})

	it("recursively copies nested files", () => {
		mkdirSync(join(srcDir, "nested", "deeper"), { recursive: true })
		writeFileSync(join(srcDir, "nested", "a.txt"), "alpha")
		writeFileSync(join(srcDir, "nested", "deeper", "b.txt"), "beta")

		copySupportingFiles(srcDir, dstDir)

		expect(readFileSync(join(dstDir, "nested", "a.txt"), "utf-8")).toBe("alpha")
		expect(readFileSync(join(dstDir, "nested", "deeper", "b.txt"), "utf-8")).toBe("beta")
	})

	it("skips entries matching skipName", () => {
		writeFileSync(join(srcDir, "kimchi"), "binary")
		writeFileSync(join(srcDir, "keepme.txt"), "ok")

		copySupportingFiles(srcDir, dstDir, "kimchi")

		expect(readFileSync(join(dstDir, "keepme.txt"), "utf-8")).toBe("ok")
		expect(() => readFileSync(join(dstDir, "kimchi"))).toThrow()
	})
})

describe("atomicInstall", () => {
	let tmp: string
	let prevXdg: string | undefined
	let prevPlatform: PropertyDescriptor | undefined

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "kimchi-atomic-install-test-"))
		prevXdg = process.env.XDG_CACHE_HOME
		process.env.XDG_CACHE_HOME = tmp
		mocks.renameSync = null
	})

	afterEach(() => {
		if (prevXdg === undefined) process.env.XDG_CACHE_HOME = undefined
		else process.env.XDG_CACHE_HOME = prevXdg
		rmSync(tmp, { recursive: true, force: true })
		mocks.renameSync = null
		if (prevPlatform) {
			Object.defineProperty(process, "platform", prevPlatform)
			prevPlatform = undefined
		}
	})

	function setPlatform(platform: string) {
		prevPlatform = Object.getOwnPropertyDescriptor(process, "platform")
		Object.defineProperty(process, "platform", {
			value: platform,
			configurable: true,
		})
	}

	it("same-fs rename: replaces current binary and creates backup on POSIX", () => {
		setPlatform("linux")
		const currentPath = join(tmp, "bin", "kimchi")
		const newPath = join(tmp, "new", "kimchi")
		mkdirSync(join(tmp, "bin"), { recursive: true })
		mkdirSync(join(tmp, "new"), { recursive: true })
		writeFileSync(currentPath, "old-binary")
		writeFileSync(newPath, "new-binary")

		const result = atomicInstall(newPath, currentPath)

		expect(readFileSync(currentPath, "utf-8")).toBe("new-binary")
		expect(result.backupPath).toBeDefined()
		expect(readFileSync(result.backupPath as string, "utf-8")).toBe("old-binary")
	})

	it("EXDEV fallback: copies and renames when rename crosses filesystems", async () => {
		setPlatform("linux")
		const currentPath = join(tmp, "bin", "kimchi")
		const newPath = join(tmp, "new", "kimchi")
		mkdirSync(join(tmp, "bin"), { recursive: true })
		mkdirSync(join(tmp, "new"), { recursive: true })
		writeFileSync(currentPath, "old-binary")
		writeFileSync(newPath, "new-binary")
		chmodSync(newPath, 0o755)

		const { renameSync: realRename } = await vi.importActual<typeof import("node:fs")>("node:fs")
		mocks.renameSync = (oldPath: string, newPathArg: string) => {
			if (oldPath === newPath) {
				const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException
				err.code = "EXDEV"
				err.syscall = "rename"
				throw err
			}
			return realRename(oldPath, newPathArg)
		}

		const result = atomicInstall(newPath, currentPath)

		expect(readFileSync(currentPath, "utf-8")).toBe("new-binary")
		expect(result.backupPath).toBeDefined()
		expect(readFileSync(result.backupPath as string, "utf-8")).toBe("old-binary")

		// The temp copy → rename fallback must preserve the executable bit.
		expect(statSync(currentPath).mode & 0o111).toBeGreaterThan(0)
	})

	it("propagates non-EXDEV errors and leaves current binary intact", async () => {
		setPlatform("linux")
		const currentPath = join(tmp, "bin", "kimchi")
		const newPath = join(tmp, "new", "kimchi")
		mkdirSync(join(tmp, "bin"), { recursive: true })
		mkdirSync(join(tmp, "new"), { recursive: true })
		writeFileSync(currentPath, "old-binary")
		writeFileSync(newPath, "new-binary")

		const { renameSync: realRename } = await vi.importActual<typeof import("node:fs")>("node:fs")
		mocks.renameSync = (oldPath: string, newPathArg: string) => {
			if (oldPath === newPath) {
				const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException
				err.code = "EPERM"
				throw err
			}
			return realRename(oldPath, newPathArg)
		}

		expect(() => atomicInstall(newPath, currentPath)).toThrow("EPERM")
		expect(readFileSync(currentPath, "utf-8")).toBe("old-binary")
	})

	it("cleans up temp file when EXDEV rename of temp fails", async () => {
		setPlatform("linux")
		const currentPath = join(tmp, "bin", "kimchi")
		const newPath = join(tmp, "new", "kimchi")
		mkdirSync(join(tmp, "bin"), { recursive: true })
		mkdirSync(join(tmp, "new"), { recursive: true })
		writeFileSync(currentPath, "old-binary")
		writeFileSync(newPath, "new-binary")

		const { renameSync: realRename } = await vi.importActual<typeof import("node:fs")>("node:fs")
		let tempPathSeen = ""
		mocks.renameSync = (oldPath: string, newPathArg: string) => {
			if (oldPath === newPath) {
				const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException
				err.code = "EXDEV"
				throw err
			}
			if (newPathArg === currentPath && oldPath !== newPath) {
				// This is the temp -> current rename. Fail it once.
				if (!tempPathSeen) {
					tempPathSeen = oldPath
					const err = new Error("EIO: I/O error") as NodeJS.ErrnoException
					err.code = "EIO"
					throw err
				}
			}
			return realRename(oldPath, newPathArg)
		}

		expect(() => atomicInstall(newPath, currentPath)).toThrow("EIO")
		expect(readFileSync(currentPath, "utf-8")).toBe("old-binary")
		// Temp file should have been cleaned up
		expect(tempPathSeen).not.toBe("")
		if (tempPathSeen) {
			expect(() => readFileSync(tempPathSeen)).toThrow()
		}
	})
})
