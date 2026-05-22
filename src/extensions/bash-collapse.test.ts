import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	_resetRtkState,
	collapseCommand,
	detectRtk,
	getBashCommandForDisplay,
	rewritePreparedBashCommand,
	rewriteWithRtk,
	rtkSpawnHook,
} from "./bash-collapse.js"

// ---------------------------------------------------------------------------
// collapseCommand
// ---------------------------------------------------------------------------

describe("collapseCommand", () => {
	it("collapses consecutive newlines into a printable arrow", () => {
		expect(collapseCommand("echo hello\necho world")).toBe("echo hello ⏎ echo world")
	})

	it("handles multiple consecutive newlines", () => {
		// Multiple consecutive newlines collapse into a single arrow.
		expect(collapseCommand("cat << 'EOF'\nhello\n\nworld\nEOF")).toBe("cat << 'EOF' ⏎ hello ⏎ world ⏎ EOF")
	})

	it("leaves single-line commands untouched", () => {
		expect(collapseCommand("git status")).toBe("git status")
	})

	it("defaults to empty string when command is undefined", () => {
		expect(collapseCommand(undefined)).toBe("")
	})
})

describe("rewritePreparedBashCommand", () => {
	it("rewrites the plain command when no shell prefix was applied", () => {
		expect(rewritePreparedBashCommand("git status", "git status", "rtk git status")).toBe("rtk git status")
	})

	it("preserves shell setup before the original command", () => {
		expect(rewritePreparedBashCommand("shopt -s expand_aliases\ngit status", "git status", "rtk git status")).toBe(
			"shopt -s expand_aliases\nrtk git status",
		)
	})

	it("falls back to the rewritten command when the prepared command cannot be matched", () => {
		expect(rewritePreparedBashCommand("git status && echo done", "git status", "rtk git status")).toBe("rtk git status")
	})
})

// ---------------------------------------------------------------------------
// RTK integration
// ---------------------------------------------------------------------------

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void

// We mock node:child_process at the module level so every `execFile` and
// `execFileSync` call inside bash-collapse.ts is intercepted.
vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	execFileSync: vi.fn(),
}))

// Import the mocked functions so we can control them per-test.
import { execFile, execFileSync } from "node:child_process"
const mockExecFile = execFile as unknown as MockInstance
const mockExecFileSync = execFileSync as unknown as MockInstance

describe("detectRtk", () => {
	beforeEach(() => {
		_resetRtkState()
		mockExecFile.mockReset()
	})

	it("returns true when rtk --version succeeds", async () => {
		mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
			cb(null, "rtk 0.40.0\n", "")
		})
		expect(await detectRtk()).toBe(true)
	})

	it("returns false when rtk is not found (ENOENT)", async () => {
		mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
			const err = Object.assign(new Error("spawn rtk ENOENT"), { code: "ENOENT" })
			cb(err, "", "")
		})
		expect(await detectRtk()).toBe(false)
	})

	it("caches the result on subsequent calls", async () => {
		mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
			cb(null, "rtk 0.40.0\n", "")
		})
		await detectRtk()
		await detectRtk()
		// execFile should only be called once — the second call uses the cache.
		expect(mockExecFile).toHaveBeenCalledTimes(1)
	})

	it("shares the in-flight promise for concurrent callers", async () => {
		mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
			// Simulate a slow response.
			setTimeout(() => cb(null, "rtk 0.40.0\n", ""), 10)
		})
		// Fire two concurrent calls before the first resolves.
		const [a, b] = await Promise.all([detectRtk(), detectRtk()])
		expect(a).toBe(true)
		expect(b).toBe(true)
		// Only one execFile call — the second caller shares the in-flight promise.
		expect(mockExecFile).toHaveBeenCalledTimes(1)
	})
})

describe("rewriteWithRtk", () => {
	let tmpRtkRoot: string | undefined
	let previousKimchiDir: string | undefined
	let previousHome: string | undefined

	beforeEach(() => {
		_resetRtkState()
		previousKimchiDir = process.env.KIMCHI_CODING_AGENT_DIR
		previousHome = process.env.HOME
		tmpRtkRoot = mkdtempSync(join(tmpdir(), "kimchi-rtk-collapse-test-"))
		process.env.KIMCHI_CODING_AGENT_DIR = tmpRtkRoot
		process.env.HOME = tmpRtkRoot
		mockExecFileSync.mockReset()
		// Pre-seed rtkAvailable = true for most tests (detectRtk already passed).
		mockExecFile.mockReset()
	})

	afterEach(() => {
		if (tmpRtkRoot) rmSync(tmpRtkRoot, { recursive: true, force: true })
		tmpRtkRoot = undefined
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete.
		if (previousKimchiDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
		else process.env.KIMCHI_CODING_AGENT_DIR = previousKimchiDir
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete.
		if (previousHome === undefined) delete process.env.HOME
		else process.env.HOME = previousHome
	})

	function seedRtkAvailable(): void {
		// Mark rtk as available without going through async detectRtk.
		// We do this by calling detectRtk with a mock that succeeds.
		mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
			cb(null, "rtk 0.40.0\n", "")
		})
	}

	it("returns the rewritten command when rtk exits 0 with different output", async () => {
		seedRtkAvailable()
		await detectRtk()

		mockExecFileSync.mockReturnValueOnce("rtk git status\n")
		expect(rewriteWithRtk("git status")).toBe("rtk git status")
	})

	it("returns the rewritten command when rtk exits 3 (rewrite success code)", async () => {
		seedRtkAvailable()
		await detectRtk()

		// execFileSync throws on non-zero exit codes; RTK uses exit 3 for rewrites.
		mockExecFileSync.mockImplementationOnce(() => {
			throw Object.assign(new Error("Command failed"), { status: 3, stdout: "rtk cargo test\n" })
		})
		expect(rewriteWithRtk("cargo test")).toBe("rtk cargo test")
	})

	it("keeps RTK rewrite output readable when it emits bare rtk", async () => {
		if (!tmpRtkRoot) throw new Error("test rtk root missing")
		const managed = join(tmpRtkRoot, "rtk", "rtk")
		mkdirSync(join(tmpRtkRoot, "rtk"), { recursive: true })
		writeFileSync(managed, "")
		seedRtkAvailable()
		await detectRtk()

		mockExecFileSync.mockReturnValueOnce("rtk git status\n")
		expect(rewriteWithRtk("git status")).toBe("rtk git status")
	})

	it("returns the original command when rtk output matches the input", async () => {
		seedRtkAvailable()
		await detectRtk()

		mockExecFileSync.mockReturnValueOnce("echo hello\n")
		expect(rewriteWithRtk("echo hello")).toBe("echo hello")
	})

	it("returns the original command when rtk output is empty", async () => {
		seedRtkAvailable()
		await detectRtk()

		mockExecFileSync.mockReturnValueOnce("")
		expect(rewriteWithRtk("git status")).toBe("git status")
	})

	it("returns the original command when execFileSync throws with non-3 exit", async () => {
		seedRtkAvailable()
		await detectRtk()

		mockExecFileSync.mockImplementationOnce(() => {
			throw Object.assign(new Error("exit code 2"), { status: 2 })
		})
		expect(rewriteWithRtk("git status")).toBe("git status")
	})

	it("returns the original command and caches negative on ENOENT", () => {
		// rtkAvailable is still undefined (no detectRtk call).
		mockExecFileSync.mockImplementationOnce(() => {
			throw Object.assign(new Error("spawn rtk ENOENT"), { code: "ENOENT" })
		})
		expect(rewriteWithRtk("git status")).toBe("git status")

		// After ENOENT, subsequent calls should not spawn at all.
		mockExecFileSync.mockClear()
		expect(rewriteWithRtk("cargo test")).toBe("cargo test")
		expect(mockExecFileSync).not.toHaveBeenCalled()
	})

	it("passes the command as a single argv element (no shell injection)", async () => {
		seedRtkAvailable()
		await detectRtk()

		mockExecFileSync.mockImplementationOnce((cmd: string, args: string[]) => {
			// Verify the command is passed as a single argument, not split.
			expect(cmd).toBe("rtk")
			expect(args).toEqual(["rewrite", "git log --oneline -10 && echo done"])
			return "rtk git log --oneline -10 && echo done\n"
		})
		rewriteWithRtk("git log --oneline -10 && echo done")
	})
})

describe("rtkSpawnHook", () => {
	let tmpRtkRoot: string | undefined
	let previousKimchiDir: string | undefined
	let previousHome: string | undefined

	beforeEach(() => {
		_resetRtkState()
		previousKimchiDir = process.env.KIMCHI_CODING_AGENT_DIR
		previousHome = process.env.HOME
		tmpRtkRoot = mkdtempSync(join(tmpdir(), "kimchi-rtk-spawn-test-"))
		process.env.KIMCHI_CODING_AGENT_DIR = tmpRtkRoot
		process.env.HOME = tmpRtkRoot
		mockExecFileSync.mockReset()
		mockExecFile.mockReset()
	})

	afterEach(() => {
		if (tmpRtkRoot) rmSync(tmpRtkRoot, { recursive: true, force: true })
		tmpRtkRoot = undefined
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete.
		if (previousKimchiDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
		else process.env.KIMCHI_CODING_AGENT_DIR = previousKimchiDir
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete.
		if (previousHome === undefined) delete process.env.HOME
		else process.env.HOME = previousHome
	})

	it("rewrites the command in a BashSpawnContext", async () => {
		// Seed rtk as available.
		mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
			cb(null, "rtk 0.40.0\n", "")
		})
		await detectRtk()

		mockExecFileSync.mockReturnValueOnce("rtk git status\n")
		const ctx = { command: "git status", cwd: "/tmp", env: process.env }
		const result = rtkSpawnHook(ctx)
		expect(result.command).toBe("rtk git status")
		expect(result.cwd).toBe("/tmp")
		expect(getBashCommandForDisplay("git status")).toBe("rtk git status")
	})

	it("returns the original context when command is unchanged", async () => {
		mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
			cb(null, "rtk 0.40.0\n", "")
		})
		await detectRtk()

		mockExecFileSync.mockReturnValueOnce("echo hello\n")
		const ctx = { command: "echo hello", cwd: "/tmp", env: process.env }
		const result = rtkSpawnHook(ctx)
		expect(result).toBe(ctx) // Same reference — no copy.
	})
})
