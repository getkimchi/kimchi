import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest"
import {
	_resetRtkState,
	detectRtk,
	isRtkPassthrough,
	rewritePreparedBashCommand,
	rewriteWithRtk,
} from "./rtk-rewrite.js"

// ---------------------------------------------------------------------------
// isRtkPassthrough
// ---------------------------------------------------------------------------

describe("isRtkPassthrough", () => {
	it.each([
		// package-manager scripts
		"pnpm run lint",
		"npm run lint",
		"yarn run build",
		"bun run test",
		"pnpm run lint --fix",
		"npm run lint:fix",
		"  pnpm run lint", // leading whitespace
		// package-manager built-ins
		"npm install",
		"npm ci",
		"yarn install",
		"yarn add react",
		"bun install",
		"bun add react",
		// package launchers
		"npx eslint .",
		"bunx tsx script.ts",
		// all pnpm commands are passed through
		"pnpm lint",
		"pnpm build",
		"pnpm typecheck",
		"pnpm lint:fix",
		"pnpm dev",
		"pnpm check",
		"pnpm install",
		"pnpm add react",
		"pnpm i",
		"pnpm update",
		"pnpm remove lodash",
		"pnpm exec eslint .",
		// package-manager commands in compound shell expressions
		"cd /tmp && pnpm exec vitest --version",
		"cd '/tmp/project with spaces' && npm install",
		"git status || bunx tsx script.ts",
		"(pnpm run lint)",
		"$(pnpm run lint)",
		"echo $(pnpm run lint)",
		"cat <(pnpm run lint)",
		"{ pnpm run lint; }",
		"if true; then pnpm test; fi",
		"echo ready\npnpm test",
		"# run tests\npnpm test",
		"  # run tests\npnpm test",
		// leading environment assignments still invoke pnpm directly
		"CI=1 pnpm test",
		// Parse failures bypass the optional RTK optimization rather than risk
		// changing the command's semantics.
		"git status ${BROKEN",
	])("returns true for %s", (cmd) => {
		expect(isRtkPassthrough(cmd)).toBe(true)
	})

	it.each([
		"git status",
		"cargo test",
		"echo pnpm run lint", // pnpm not at start
		'echo "cd /tmp && pnpm exec vitest --version"',
		"echo '$(pnpm test)'", // single-quoted command substitution is literal text
		"echo ready && echo pnpm exec vitest --version",
		"bash -c 'pnpm exec vitest --version'",
	])("returns false for %s", (cmd) => {
		expect(isRtkPassthrough(cmd)).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// rewritePreparedBashCommand
// ---------------------------------------------------------------------------

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
// `execFileSync` call inside rtk-rewrite.ts is intercepted.
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
		tmpRtkRoot = mkdtempSync(join(tmpdir(), "kimchi-rtk-rewrite-test-"))
		process.env.KIMCHI_CODING_AGENT_DIR = tmpRtkRoot
		process.env.HOME = tmpRtkRoot
		mockExecFileSync.mockReset()
		mockExecFile.mockReset()
	})

	afterEach(() => {
		if (tmpRtkRoot) rmSync(tmpRtkRoot, { recursive: true, force: true })
		tmpRtkRoot = undefined
		if (previousKimchiDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
		else process.env.KIMCHI_CODING_AGENT_DIR = previousKimchiDir
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

	it("does not call rtk for package-manager or launcher invocations", async () => {
		seedRtkAvailable()
		await detectRtk()

		expect(rewriteWithRtk("pnpm run lint")).toBe("pnpm run lint")
		expect(rewriteWithRtk("npm install")).toBe("npm install")
		expect(rewriteWithRtk("cd /tmp && npm install")).toBe("cd /tmp && npm install")
		expect(rewriteWithRtk("yarn add react")).toBe("yarn add react")
		expect(rewriteWithRtk("bun install")).toBe("bun install")
		expect(rewriteWithRtk("npx eslint .")).toBe("npx eslint .")
		expect(rewriteWithRtk("cd /tmp && pnpm exec vitest --version")).toBe("cd /tmp && pnpm exec vitest --version")
		expect(mockExecFileSync).not.toHaveBeenCalled()
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
