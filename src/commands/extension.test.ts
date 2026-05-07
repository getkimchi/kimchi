import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the pi-coding-agent module before importing the command under test
const mockInstallAndPersist = vi.fn().mockResolvedValue(undefined)
const mockRemoveAndPersist = vi.fn().mockResolvedValue(true)
const mockUpdate = vi.fn().mockResolvedValue(undefined)
const mockListConfiguredPackages = vi.fn().mockReturnValue([])

vi.mock("@mariozechner/pi-coding-agent", () => ({
	getAgentDir: () => "/mock/agent/dir",
	SettingsManager: {
		create: () => ({}),
	},
	DefaultPackageManager: vi.fn().mockImplementation(() => ({
		installAndPersist: mockInstallAndPersist,
		removeAndPersist: mockRemoveAndPersist,
		update: mockUpdate,
		listConfiguredPackages: mockListConfiguredPackages,
	})),
}))

// Mock node:fs for enable/disable tests
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		readFileSync: vi.fn().mockImplementation((path: string, encoding?: string) => {
			if (typeof encoding === "string" && String(path).endsWith("settings.json")) {
				return JSON.stringify({ packages: ["/some/local/path"] })
			}
			return actual.readFileSync(path, encoding as BufferEncoding)
		}),
		writeFileSync: vi.fn(),
	}
})

import { readFileSync, writeFileSync } from "node:fs"
import { runExtension } from "./extension.js"

describe("runExtension", () => {
	let logSpy: ReturnType<typeof vi.spyOn>
	let errSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		// Re-establish defaults after clearAllMocks resets implementations
		mockInstallAndPersist.mockResolvedValue(undefined)
		mockRemoveAndPersist.mockResolvedValue(true)
		mockUpdate.mockResolvedValue(undefined)
		mockListConfiguredPackages.mockReturnValue([])
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		logSpy.mockRestore()
		errSpy.mockRestore()
	})

	// ---------------------------------------------------------------------------
	// Usage / help
	// ---------------------------------------------------------------------------

	it("no args prints usage and returns 1", async () => {
		const code = await runExtension([])
		expect(code).toBe(1)
		const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(output).toContain("Usage: kimchi extension")
	})

	it("--help prints usage and returns 0", async () => {
		const code = await runExtension(["--help"])
		expect(code).toBe(0)
		const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(output).toContain("Usage: kimchi extension")
	})

	it("-h prints usage and returns 0", async () => {
		const code = await runExtension(["-h"])
		expect(code).toBe(0)
	})

	it("unknown subcommand prints error and returns 2", async () => {
		const code = await runExtension(["frob"])
		expect(code).toBe(2)
		const errors = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(errors).toContain('unknown subcommand "frob"')
	})

	// ---------------------------------------------------------------------------
	// add
	// ---------------------------------------------------------------------------

	it("add <source> calls installAndPersist and returns 0", async () => {
		const code = await runExtension(["add", "npm:@foo/bar"])
		expect(code).toBe(0)
		expect(mockInstallAndPersist).toHaveBeenCalledWith("npm:@foo/bar", { local: false })
	})

	it("add with --local passes local:true", async () => {
		const code = await runExtension(["add", "--local", "npm:@foo/bar"])
		expect(code).toBe(0)
		expect(mockInstallAndPersist).toHaveBeenCalledWith("npm:@foo/bar", { local: true })
	})

	it("add with no source returns 2", async () => {
		const code = await runExtension(["add"])
		expect(code).toBe(2)
		const errors = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(errors).toContain("missing <source>")
	})

	it("add returns 1 when installAndPersist throws", async () => {
		mockInstallAndPersist.mockRejectedValueOnce(new Error("network error"))
		const code = await runExtension(["add", "npm:@foo/bar"])
		expect(code).toBe(1)
		const errors = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(errors).toContain("network error")
	})

	// ---------------------------------------------------------------------------
	// remove
	// ---------------------------------------------------------------------------

	it("remove <source> calls removeAndPersist and returns 0", async () => {
		const code = await runExtension(["remove", "npm:@foo/bar"])
		expect(code).toBe(0)
		expect(mockRemoveAndPersist).toHaveBeenCalledWith("npm:@foo/bar", { local: false })
	})

	it("remove returns 1 when package not found (removeAndPersist returns false)", async () => {
		mockRemoveAndPersist.mockResolvedValueOnce(false)
		const code = await runExtension(["remove", "npm:@foo/bar"])
		expect(code).toBe(1)
		const errors = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(errors).toContain("package not found")
	})

	it("remove with no source returns 2", async () => {
		const code = await runExtension(["remove"])
		expect(code).toBe(2)
	})

	// ---------------------------------------------------------------------------
	// list
	// ---------------------------------------------------------------------------

	it("list with no packages prints empty message", async () => {
		mockListConfiguredPackages.mockReturnValueOnce([])
		const code = await runExtension(["list"])
		expect(code).toBe(0)
		const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(output).toContain("No extensions configured")
	})

	it("list shows package source and status", async () => {
		mockListConfiguredPackages.mockReturnValueOnce([
			{ source: "npm:@foo/bar", scope: "user", filtered: false },
			{ source: "git:github.com/user/repo", scope: "project", filtered: true },
		])
		const code = await runExtension(["list"])
		expect(code).toBe(0)
		const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(output).toContain("npm:@foo/bar")
		expect(output).toContain("enabled")
		expect(output).toContain("git:github.com/user/repo")
		expect(output).toContain("[project]")
	})

	// ---------------------------------------------------------------------------
	// enable / disable
	// ---------------------------------------------------------------------------

	it("enable returns 1 when package not found in settings.json", async () => {
		vi.mocked(readFileSync).mockImplementationOnce(() => JSON.stringify({ packages: [] }))
		const code = await runExtension(["enable", "npm:@foo/bar"])
		expect(code).toBe(1)
		const errors = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(errors).toContain("package not found")
	})

	it("enable with object entry removes disabled field and writes", async () => {
		vi.mocked(readFileSync).mockImplementationOnce(() =>
			JSON.stringify({ packages: [{ source: "npm:@foo/bar", disabled: true }] }),
		)
		const code = await runExtension(["enable", "npm:@foo/bar"])
		expect(code).toBe(0)
		expect(writeFileSync).toHaveBeenCalled()
		const writtenData = JSON.parse((vi.mocked(writeFileSync).mock.calls[0][1] as string).trim()) as {
			packages: Array<{ source: string; disabled?: boolean }>
		}
		expect(writtenData.packages[0]).not.toHaveProperty("disabled")
	})

	it("enable with string entry prints already enabled", async () => {
		vi.mocked(readFileSync).mockImplementationOnce(() => JSON.stringify({ packages: ["npm:@foo/bar"] }))
		const code = await runExtension(["enable", "npm:@foo/bar"])
		expect(code).toBe(0)
		const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(output).toContain("already enabled")
	})

	it("disable converts string entry to object with disabled:true", async () => {
		vi.mocked(readFileSync).mockImplementationOnce(() => JSON.stringify({ packages: ["npm:@foo/bar"] }))
		const code = await runExtension(["disable", "npm:@foo/bar"])
		expect(code).toBe(0)
		expect(writeFileSync).toHaveBeenCalled()
		const writtenData = JSON.parse((vi.mocked(writeFileSync).mock.calls[0][1] as string).trim()) as {
			packages: Array<{ source: string; disabled: boolean }>
		}
		expect(writtenData.packages[0]).toEqual({ source: "npm:@foo/bar", disabled: true })
	})

	it("disable returns 1 when package not found", async () => {
		vi.mocked(readFileSync).mockImplementationOnce(() => JSON.stringify({ packages: [] }))
		const code = await runExtension(["disable", "npm:@foo/bar"])
		expect(code).toBe(1)
	})

	it("enable/disable with no source returns 2", async () => {
		expect(await runExtension(["enable"])).toBe(2)
		expect(await runExtension(["disable"])).toBe(2)
	})

	// ---------------------------------------------------------------------------
	// update
	// ---------------------------------------------------------------------------

	it("update with no source calls pm.update(undefined)", async () => {
		const code = await runExtension(["update"])
		expect(code).toBe(0)
		expect(mockUpdate).toHaveBeenCalledWith(undefined)
		const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(output).toContain("All extensions updated")
	})

	it("update <source> calls pm.update with source", async () => {
		const code = await runExtension(["update", "npm:@foo/bar"])
		expect(code).toBe(0)
		expect(mockUpdate).toHaveBeenCalledWith("npm:@foo/bar")
		const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(output).toContain("npm:@foo/bar")
	})

	it("update returns 1 when pm.update throws", async () => {
		mockUpdate.mockRejectedValueOnce(new Error("git pull failed"))
		const code = await runExtension(["update", "git:github.com/user/repo"])
		expect(code).toBe(1)
		const errors = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(errors).toContain("git pull failed")
	})

	// ---------------------------------------------------------------------------
	// --local flag stripping
	// ---------------------------------------------------------------------------

	it("--local flag is stripped before subcommand resolution", async () => {
		const code = await runExtension(["--local", "add", "npm:@foo/bar"])
		expect(code).toBe(0)
		expect(mockInstallAndPersist).toHaveBeenCalledWith("npm:@foo/bar", { local: true })
	})
})
