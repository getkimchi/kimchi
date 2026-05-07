import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TaskSpec } from "../autonomous/spec.js"
import { buildAutoArgs, buildExtensionFactories, parseAutoArgs, runAuto } from "./auto.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpec(overrides?: Partial<TaskSpec>): TaskSpec {
	return {
		prompt: "do the thing",
		timeout_seconds: 3600,
		...overrides,
	}
}

// ---------------------------------------------------------------------------
// parseAutoArgs
// ---------------------------------------------------------------------------

describe("parseAutoArgs", () => {
	it("bare positional prompt ends up in passthroughArgs", () => {
		const result = parseAutoArgs(["do the thing"])
		expect(result).toMatchObject({ passthroughArgs: ["do the thing"], help: false })
		expect(result.taskPath).toBeUndefined()
	})

	it("@file.md passthrough ends up in passthroughArgs", () => {
		const result = parseAutoArgs(["@instructions.md"])
		expect(result.passthroughArgs).toContain("@instructions.md")
	})

	it("--task <path> sets taskPath and does not appear in passthroughArgs", () => {
		const result = parseAutoArgs(["--task", "/tmp/spec.json"])
		expect(result.taskPath).toBe("/tmp/spec.json")
		expect(result.passthroughArgs).not.toContain("--task")
		expect(result.passthroughArgs).not.toContain("/tmp/spec.json")
	})

	it("--iterations N sets iterations", () => {
		const result = parseAutoArgs(["--iterations", "5"])
		expect(result.iterations).toBe(5)
	})

	it("--max-iterations N sets iterations (alias)", () => {
		const result = parseAutoArgs(["--max-iterations", "10"])
		expect(result.iterations).toBe(10)
	})

	it("--timeout-seconds N sets timeoutSeconds", () => {
		const result = parseAutoArgs(["--timeout-seconds", "120"])
		expect(result.timeoutSeconds).toBe(120)
	})

	it("mix of flags: --task, --iterations, --timeout-seconds, and passthrough", () => {
		const result = parseAutoArgs([
			"--task",
			"/tmp/spec.json",
			"--iterations",
			"3",
			"--timeout-seconds",
			"60",
			"@file.md",
		])
		expect(result.taskPath).toBe("/tmp/spec.json")
		expect(result.iterations).toBe(3)
		expect(result.timeoutSeconds).toBe(60)
		expect(result.passthroughArgs).toContain("@file.md")
	})

	it("--help returns { help: true, passthroughArgs: [] }", () => {
		const result = parseAutoArgs(["--help"])
		expect(result.help).toBe(true)
		expect(result.passthroughArgs).toEqual([])
	})

	it("-h returns { help: true, passthroughArgs: [] }", () => {
		const result = parseAutoArgs(["-h"])
		expect(result.help).toBe(true)
	})

	it("throws when --task has no value", () => {
		expect(() => parseAutoArgs(["--task"])).toThrow(/missing --task value/)
	})

	it("throws when --task next token starts with -", () => {
		expect(() => parseAutoArgs(["--task", "--other"])).toThrow(/missing --task value/)
	})

	it("throws when --iterations has no value", () => {
		expect(() => parseAutoArgs(["--iterations"])).toThrow(/missing --iterations value/)
	})

	it("throws when --iterations value is not a positive integer", () => {
		expect(() => parseAutoArgs(["--iterations", "0"])).toThrow(/positive integer/)
		expect(() => parseAutoArgs(["--iterations", "-1"])).toThrow(/positive integer/)
	})

	it("throws when --timeout-seconds has no value", () => {
		expect(() => parseAutoArgs(["--timeout-seconds"])).toThrow(/missing --timeout-seconds value/)
	})

	it("empty array returns no taskPath, no iterations, no timeout, empty passthroughArgs", () => {
		const result = parseAutoArgs([])
		expect(result).toEqual({ help: false, passthroughArgs: [] })
	})

	it("does not mutate the input args array", () => {
		const args = ["--task", "/tmp/spec.json", "--extra"]
		const copy = [...args]
		parseAutoArgs(args)
		expect(args).toEqual(copy)
	})
})

// ---------------------------------------------------------------------------
// buildAutoArgs
// ---------------------------------------------------------------------------

describe("buildAutoArgs", () => {
	const emptyParsed = { help: false, passthroughArgs: [] }

	it("no spec + empty passthrough returns the four forced flags", () => {
		const result = buildAutoArgs(undefined, emptyParsed)
		expect(result).toEqual(["--yolo", "--print", "--mode", "json", "--no-session"])
	})

	it("spec.prompt is inserted after the forced flags", () => {
		const spec = makeSpec({ prompt: "do the thing" })
		const result = buildAutoArgs(spec, emptyParsed)
		expect(result).toEqual(["--yolo", "--print", "--mode", "json", "--no-session", "do the thing"])
	})

	it("spec.model adds --model flag between --no-session and prompt", () => {
		const spec = makeSpec({ prompt: "do the thing", model: "claude-opus-4-5" })
		const result = buildAutoArgs(spec, emptyParsed)
		expect(result).toEqual([
			"--yolo",
			"--print",
			"--mode",
			"json",
			"--no-session",
			"--model",
			"claude-opus-4-5",
			"do the thing",
		])
	})

	it("passthroughArgs are appended after spec.prompt", () => {
		const spec = makeSpec({ prompt: "do the thing" })
		const result = buildAutoArgs(spec, { ...emptyParsed, passthroughArgs: ["--verbose"] })
		expect(result).toEqual(["--yolo", "--print", "--mode", "json", "--no-session", "do the thing", "--verbose"])
	})

	it("no spec: passthroughArgs still appended after forced flags", () => {
		const result = buildAutoArgs(undefined, { ...emptyParsed, passthroughArgs: ["@file.md", "extra"] })
		expect(result).toEqual(["--yolo", "--print", "--mode", "json", "--no-session", "@file.md", "extra"])
	})

	it("returns a new array on each call (no shared reference)", () => {
		const spec = makeSpec()
		const a = buildAutoArgs(spec, emptyParsed)
		const b = buildAutoArgs(spec, emptyParsed)
		expect(a).not.toBe(b)
	})

	it("does not mutate the input spec", () => {
		const spec = makeSpec({ prompt: "do the thing", model: "some-model" })
		const before = JSON.stringify(spec)
		buildAutoArgs(spec, { ...emptyParsed, passthroughArgs: ["--extra"] })
		expect(JSON.stringify(spec)).toBe(before)
	})
})

// ---------------------------------------------------------------------------
// buildExtensionFactories
// ---------------------------------------------------------------------------

describe("buildExtensionFactories", () => {
	it("returns {factories, control} shape", async () => {
		const result = await buildExtensionFactories({}, async () => [])
		expect(result).toHaveProperty("factories")
		expect(result).toHaveProperty("control")
		expect(typeof result.control.markError).toBe("function")
		expect(typeof result.control.markTimeout).toBe("function")
		expect(typeof result.control.flush).toBe("function")
	})

	it("just resultWriter when neither iterations nor timeout set", async () => {
		const stubA = (_pi: ExtensionAPI) => {}
		const stubB = (_pi: ExtensionAPI) => {}
		const { factories } = await buildExtensionFactories({}, async () => [stubA, stubB])
		// base (2) + resultWriter (1) = 3
		expect(factories).toHaveLength(3)
		expect(factories[0]).toBe(stubA)
		expect(factories[1]).toBe(stubB)
	})

	it("resultWriter + timeoutGuard when only timeout set", async () => {
		const { factories } = await buildExtensionFactories({ timeoutSeconds: 60 }, async () => [])
		// resultWriter + timeoutGuard = 2
		expect(factories).toHaveLength(2)
	})

	it("resultWriter + maxIterations when only iterations set", async () => {
		const { factories } = await buildExtensionFactories({ iterations: 3 }, async () => [])
		// resultWriter + maxIterations = 2
		expect(factories).toHaveLength(2)
	})

	it("all three (resultWriter + timeoutGuard + maxIterations) when both set", async () => {
		const { factories } = await buildExtensionFactories({ timeoutSeconds: 60, iterations: 3 }, async () => [])
		// resultWriter + timeoutGuard + maxIterations = 3
		expect(factories).toHaveLength(3)
	})

	it("works with an empty base", async () => {
		const { factories } = await buildExtensionFactories({}, async () => [])
		expect(factories).toHaveLength(1)
	})
})

// ---------------------------------------------------------------------------
// runAuto
// ---------------------------------------------------------------------------

describe("runAuto", () => {
	let errSpy: ReturnType<typeof vi.spyOn>

	const stubBase = async () => [(_pi: ExtensionAPI) => {}, (_pi: ExtensionAPI) => {}]
	const stubPrepare = async () => {}

	beforeEach(() => {
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		errSpy.mockRestore()
	})

	it("calls runHarness with correct argv (forced flags + spec prompt) on success with --task", async () => {
		const spec = makeSpec({ prompt: "hello world" })
		const loadTaskSpec = vi.fn().mockReturnValue(spec)
		const runHarness = vi.fn().mockResolvedValue(undefined)

		await runAuto(["--task", "/tmp/spec.json"], {
			loadTaskSpec,
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment: stubPrepare,
		})

		expect(loadTaskSpec).toHaveBeenCalledWith("/tmp/spec.json")
		const [calledArgs] = runHarness.mock.calls[0]
		expect(calledArgs).toEqual(["--yolo", "--print", "--mode", "json", "--no-session", "hello world"])
	})

	it("returns 0 on success", async () => {
		const spec = makeSpec()
		const loadTaskSpec = vi.fn().mockReturnValue(spec)
		const runHarness = vi.fn().mockResolvedValue(undefined)

		const result = await runAuto(["--task", "/tmp/spec.json"], {
			loadTaskSpec,
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment: stubPrepare,
		})

		expect(result).toBe(0)
	})

	it("works without --task: passthrough args forwarded directly", async () => {
		const runHarness = vi.fn().mockResolvedValue(undefined)

		await runAuto(["@file.md", "do the thing"], {
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment: stubPrepare,
		})

		const [calledArgs] = runHarness.mock.calls[0]
		expect(calledArgs).toEqual(["--yolo", "--print", "--mode", "json", "--no-session", "@file.md", "do the thing"])
	})

	it("--iterations from CLI caps turn_end (factories include maxIterations)", async () => {
		const runHarness = vi.fn().mockResolvedValue(undefined)

		await runAuto(["--iterations", "3", "do work"], {
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment: stubPrepare,
		})

		const [, { extensionFactories }] = runHarness.mock.calls[0]
		// stubBase(2) + resultWriter + maxIterations = 4
		expect(extensionFactories).toHaveLength(4)
	})

	it("spec.iterations used when --iterations not on CLI", async () => {
		const spec = makeSpec({ iterations: 5 })
		const loadTaskSpec = vi.fn().mockReturnValue(spec)
		const runHarness = vi.fn().mockResolvedValue(undefined)

		await runAuto(["--task", "/tmp/spec.json"], {
			loadTaskSpec,
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment: stubPrepare,
		})

		const [, { extensionFactories }] = runHarness.mock.calls[0]
		// stubBase(2) + resultWriter + timeoutGuard (from spec.timeout_seconds) + maxIterations = 5
		expect(extensionFactories).toHaveLength(5)
	})

	it("CLI --iterations overrides spec.iterations", async () => {
		const spec = makeSpec({ iterations: 10 })
		const loadTaskSpec = vi.fn().mockReturnValue(spec)
		const runHarness = vi.fn().mockResolvedValue(undefined)

		await runAuto(["--task", "/tmp/spec.json", "--iterations", "2"], {
			loadTaskSpec,
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment: stubPrepare,
		})

		// Just check it runs without error; iteration count comes from CLI (2)
		expect(runHarness).toHaveBeenCalledOnce()
	})

	it("returns 1 and logs error when loadTaskSpec throws", async () => {
		const loadTaskSpec = vi.fn().mockImplementation(() => {
			throw new Error("file not found")
		})
		const runHarness = vi.fn()

		const result = await runAuto(["--task", "/tmp/spec.json"], {
			loadTaskSpec,
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment: stubPrepare,
		})

		expect(result).toBe(1)
		expect(runHarness).not.toHaveBeenCalled()
		expect(errSpy).toHaveBeenCalledWith("file not found")
	})

	it("returns 1 and logs error when runHarness throws", async () => {
		const spec = makeSpec()
		const loadTaskSpec = vi.fn().mockReturnValue(spec)
		const runHarness = vi.fn().mockRejectedValue(new Error("harness exploded"))

		const result = await runAuto(["--task", "/tmp/spec.json"], {
			loadTaskSpec,
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment: stubPrepare,
		})

		expect(result).toBe(1)
		expect(errSpy).toHaveBeenCalledWith("harness exploded")
	})

	it("calls control.markError and writes result.json with exit_reason 'error' when runHarness throws", async () => {
		const resultDir = join(tmpdir(), `auto-test-${Math.random().toString(36).slice(2)}`)
		const originalEnv = process.env.KIMCHI_RESULT_DIR
		process.env.KIMCHI_RESULT_DIR = resultDir

		try {
			const spec = makeSpec()
			const loadTaskSpec = vi.fn().mockReturnValue(spec)
			const runHarness = vi.fn().mockRejectedValue(new Error("harness exploded"))

			const result = await runAuto(["--task", "/tmp/spec.json"], {
				loadTaskSpec,
				runHarness,
				buildBaseFactories: stubBase,
				prepareEnvironment: stubPrepare,
			})

			expect(result).toBe(1)
			const manifestPath = join(resultDir, "result.json")
			expect(existsSync(manifestPath)).toBe(true)
			const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
				exit_reason: string
				error: { message: string }
			}
			expect(manifest.exit_reason).toBe("error")
			expect(manifest.error.message).toBe("harness exploded")
		} finally {
			if (originalEnv === undefined) {
				// biome-ignore lint/performance/noDelete: process.env.X = undefined coerces to "undefined" string
				delete process.env.KIMCHI_RESULT_DIR
			} else {
				process.env.KIMCHI_RESULT_DIR = originalEnv
			}
			rmSync(resultDir, { recursive: true, force: true })
		}
	})

	it("returns 0 and logs usage when --help is passed", async () => {
		const runHarness = vi.fn()
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		const result = await runAuto(["--help"], {
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment: stubPrepare,
		})

		expect(result).toBe(0)
		expect(runHarness).not.toHaveBeenCalled()
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage"))
		logSpy.mockRestore()
	})

	it("returns 0 and logs usage when -h is passed", async () => {
		const runHarness = vi.fn()
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		const result = await runAuto(["-h"], {
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment: stubPrepare,
		})

		expect(result).toBe(0)
		logSpy.mockRestore()
	})

	it("returns 1 and logs error when prepareEnvironment throws", async () => {
		const spec = makeSpec()
		const loadTaskSpec = vi.fn().mockReturnValue(spec)
		const runHarness = vi.fn()
		const prepareEnvironment = vi.fn().mockRejectedValue(new Error("KIMCHI_API_KEY is not set"))

		const result = await runAuto(["--task", "/tmp/spec.json"], {
			loadTaskSpec,
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment,
		})

		expect(result).toBe(1)
		expect(runHarness).not.toHaveBeenCalled()
		expect(errSpy).toHaveBeenCalledWith("KIMCHI_API_KEY is not set")
	})

	it("returns 1 when parseAutoArgs throws (e.g. --task with no value)", async () => {
		const runHarness = vi.fn()

		const result = await runAuto(["--task"], {
			runHarness,
			buildBaseFactories: stubBase,
			prepareEnvironment: stubPrepare,
		})

		expect(result).toBe(1)
		expect(runHarness).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// runAuto — containerized path (--runtime)
// ---------------------------------------------------------------------------

describe("runAuto containerized (--runtime)", () => {
	let errSpy: ReturnType<typeof vi.spyOn>
	let logSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		errSpy.mockRestore()
		logSpy.mockRestore()
		vi.unstubAllEnvs()
	})

	function makeFs(opts?: { existsSync?: (p: string) => boolean }) {
		return {
			existsSync: opts?.existsSync ?? (() => true),
			mkdirSync: vi.fn(),
			copyFileSync: vi.fn(),
		}
	}

	function makeRuntime(opts?: { exitCode?: number }) {
		return {
			name: "docker",
			run: vi.fn().mockResolvedValue({ exitCode: opts?.exitCode ?? 0, durationMs: 100 }),
		}
	}

	function makeReadResult(opts?: { exit_reason?: string; error?: { message: string }; throws?: boolean }) {
		return vi.fn().mockImplementation(() => {
			if (opts?.throws) throw new Error("manifest missing")
			return {
				exit_reason: opts?.exit_reason ?? "done",
				started_at: "2026-05-07T00:00:00.000Z",
				ended_at: "2026-05-07T00:00:01.000Z",
				...(opts?.error ? { error: opts.error } : {}),
			}
		})
	}

	it("happy path: returns 0 when runtime exits 0 and manifest reads ok", async () => {
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		const result = await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker", "--workspace", "/tmp/ws"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => makeRuntime({ exitCode: 0 }),
			readResult: makeReadResult(),
			fs: makeFs(),
		})
		expect(result).toBe(0)
	})

	it("propagates non-zero container exit code", async () => {
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		const result = await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker", "--workspace", "/tmp/ws"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => makeRuntime({ exitCode: 124 }),
			readResult: makeReadResult({ exit_reason: "timeout" }),
			fs: makeFs(),
		})
		expect(result).toBe(124)
	})

	it("returns 1 when --task is not provided (--runtime requires --task)", async () => {
		const result = await runAuto(["--runtime", "docker", "--workspace", "/tmp/ws"], {
			selectRuntime: () => makeRuntime(),
			readResult: makeReadResult(),
			fs: makeFs(),
		})
		expect(result).toBe(1)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("--task"))
	})

	it("returns 1 when workspace does not exist", async () => {
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		const result = await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker", "--workspace", "/nope"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => makeRuntime(),
			readResult: makeReadResult(),
			fs: makeFs({ existsSync: () => false }),
		})
		expect(result).toBe(1)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("workspace not found"))
	})

	it("returns 1 when selectRuntime throws (unknown name)", async () => {
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		const result = await runAuto(["--task", "/tmp/spec.json", "--runtime", "nope", "--workspace", "/tmp/ws"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => {
				throw new Error("Unknown runtime: nope")
			},
			readResult: makeReadResult(),
			fs: makeFs(),
		})
		expect(result).toBe(1)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown runtime"))
	})

	it("returns 1 when manifest read throws and container exited 0 (missing manifest is failure)", async () => {
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		const result = await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker", "--workspace", "/tmp/ws"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => makeRuntime({ exitCode: 0 }),
			readResult: makeReadResult({ throws: true }),
			fs: makeFs(),
		})
		expect(result).toBe(1)
	})

	it("preserves non-zero container exit code when manifest read throws", async () => {
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		const result = await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker", "--workspace", "/tmp/ws"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => makeRuntime({ exitCode: 137 }),
			readResult: makeReadResult({ throws: true }),
			fs: makeFs(),
		})
		expect(result).toBe(137)
	})

	it("forwards KIMCHI_API_KEY from host env into container env", async () => {
		vi.stubEnv("KIMCHI_API_KEY", "test-key-123")
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		const runtime = makeRuntime()
		await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker", "--workspace", "/tmp/ws"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => runtime,
			readResult: makeReadResult(),
			fs: makeFs(),
		})
		const runOpts = runtime.run.mock.calls[0][0]
		expect(runOpts.env.KIMCHI_API_KEY).toBe("test-key-123")
	})

	it("does NOT include KIMCHI_API_KEY when host env doesn't have it", async () => {
		vi.stubEnv("KIMCHI_API_KEY", "")
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		const runtime = makeRuntime()
		await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker", "--workspace", "/tmp/ws"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => runtime,
			readResult: makeReadResult(),
			fs: makeFs(),
		})
		const runOpts = runtime.run.mock.calls[0][0]
		expect(runOpts.env.KIMCHI_API_KEY).toBeUndefined()
	})

	it("rejects mount paths containing ':' or ','", async () => {
		const spec = makeSpec({
			prompt: "p",
			timeout_seconds: 60,
			mounts: [{ host: "/bad:path", container: "/x" }],
		})
		const result = await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker", "--workspace", "/tmp/ws"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => makeRuntime(),
			readResult: makeReadResult(),
			fs: makeFs(),
		})
		expect(result).toBe(1)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("invalid mount path"))
	})

	it("logs '[auto] exit_reason=...' summary on success", async () => {
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker", "--workspace", "/tmp/ws"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => makeRuntime(),
			readResult: makeReadResult({ exit_reason: "done" }),
			fs: makeFs(),
		})
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[auto] exit_reason=done"))
	})

	it("logs '[auto] error: <msg>' when manifest has error field", async () => {
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker", "--workspace", "/tmp/ws"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => makeRuntime(),
			readResult: makeReadResult({ exit_reason: "error", error: { message: "boom" } }),
			fs: makeFs(),
		})
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[auto] error: boom"))
	})

	it("default workspace is process.cwd() when --workspace not specified", async () => {
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		const runtime = makeRuntime()
		await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => runtime,
			readResult: makeReadResult(),
			fs: makeFs(),
		})
		const runOpts = runtime.run.mock.calls[0][0]
		const workspaceMount = runOpts.mounts.find((m: { container: string }) => m.container === "/workspace")
		expect(workspaceMount?.host).toBe(process.cwd())
	})

	it("default image is 'kimchi:latest' when --image not specified", async () => {
		const spec = makeSpec({ prompt: "p", timeout_seconds: 60 })
		const runtime = makeRuntime()
		await runAuto(["--task", "/tmp/spec.json", "--runtime", "docker", "--workspace", "/tmp/ws"], {
			loadTaskSpec: () => spec,
			selectRuntime: () => runtime,
			readResult: makeReadResult(),
			fs: makeFs(),
		})
		const runOpts = runtime.run.mock.calls[0][0]
		expect(runOpts.image).toBe("kimchi:latest")
	})
})
