import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock fs and child_process so we control marker-file presence and binary
// availability — mirrors lsp/servers.test.ts exactly.
vi.mock("node:fs", () => ({
	default: {
		existsSync: vi.fn(),
	},
}))

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}))

import { adapterForFile, adapterForLanguage, allAdapters, detectAdapters, detectMissingAdapters } from "./adapters.js"

const mockExistsSync = vi.mocked(fs.existsSync)
const mockSpawnSync = vi.mocked(spawnSync)

// Suppress Bun global so exists() uses the spawnSync path (deterministic).
beforeEach(() => {
	mockExistsSync.mockReset()
	mockSpawnSync.mockReset()
	// biome-ignore lint/suspicious/noExplicitAny: suppress Bun global for deterministic Node-path testing
	;(globalThis as any).Bun = undefined
})

function setFiles(files: string[]) {
	mockExistsSync.mockImplementation(((p: unknown) => {
		const rel = String(p).replace(/^\/project\//, "")
		return files.includes(rel)
	}) as never)
}

/** `setBinaries` matches args?.[0] — the binary name passed to `which [cmd]`. */
function setBinaries(onPath: string[]) {
	mockSpawnSync.mockImplementation(
		(_cmd: string, args?: readonly string[]) =>
			({
				status: onPath.includes(args?.[0] ?? "") ? 0 : 1,
			}) as never,
	)
}

describe("detectAdapters", () => {
	it("returns dlv when go.mod present and dlv binary on PATH", () => {
		setFiles(["go.mod"])
		setBinaries(["dlv"])
		const result = detectAdapters("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("dlv")
	})

	it("returns js-debug when package.json present and js-debug-adapter on PATH", () => {
		setFiles(["package.json"])
		setBinaries(["js-debug-adapter"])
		const result = detectAdapters("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("js-debug")
	})

	it("returns debugpy when pyproject.toml present and debugpy on PATH", () => {
		setFiles(["pyproject.toml"])
		setBinaries(["debugpy"])
		const result = detectAdapters("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("debugpy")
	})

	it("returns lldb-dap when Cargo.toml present and lldb-dap on PATH", () => {
		setFiles(["Cargo.toml"])
		setBinaries(["lldb-dap"])
		const result = detectAdapters("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("lldb-dap")
	})

	it("returns empty when binary is on PATH but no marker file exists", () => {
		setFiles([])
		setBinaries(["dlv", "js-debug-adapter", "debugpy", "lldb-dap"])
		expect(detectAdapters("/project")).toHaveLength(0)
	})

	it("returns empty when marker exists but binary is NOT on PATH", () => {
		setFiles(["go.mod"])
		setBinaries([])
		expect(detectAdapters("/project")).toHaveLength(0)
	})

	it("returns multiple adapters when multiple markers and binaries are present", () => {
		setFiles(["go.mod", "package.json", "Cargo.toml"])
		setBinaries(["dlv", "js-debug-adapter", "lldb-dap"])
		const result = detectAdapters("/project")
		expect(result.map((a) => a.name).sort()).toEqual(["dlv", "js-debug", "lldb-dap"])
	})

	it("does NOT return js-debug in a Go-only project even if js-debug-adapter is on PATH", () => {
		setFiles(["go.mod"])
		setBinaries(["dlv", "js-debug-adapter"])
		const result = detectAdapters("/project")
		expect(result.find((a) => a.name === "js-debug")).toBeUndefined()
		expect(result.find((a) => a.name === "dlv")).toBeDefined()
	})

	it("detects marker in a parent directory (monorepo subdirectory)", () => {
		// go.mod is in /project, but cwd is /project/services/autoscaler
		mockExistsSync.mockImplementation(((p: unknown) => {
			return String(p) === "/project/go.mod"
		}) as never)
		setBinaries(["dlv"])
		const result = detectMissingAdapters("/project/services/autoscaler")
		// marker present + binary present → not "missing"; verify detectAdapters finds it
		const detected = detectAdapters("/project/services/autoscaler")
		expect(detected).toHaveLength(1)
		expect(detected[0].name).toBe("dlv")
		expect(result).toHaveLength(0)
	})
})

describe("detectMissingAdapters", () => {
	it("returns dlv when go.mod present but dlv not on PATH", () => {
		setFiles(["go.mod"])
		setBinaries([])
		const result = detectMissingAdapters("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("dlv")
	})

	it("returns js-debug when package.json present but js-debug-adapter not on PATH", () => {
		setFiles(["package.json"])
		setBinaries([])
		const result = detectMissingAdapters("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("js-debug")
	})

	it("does NOT return an adapter whose binary IS on PATH", () => {
		setFiles(["go.mod", "package.json"])
		setBinaries(["dlv"])
		const result = detectMissingAdapters("/project")
		expect(result.find((a) => a.name === "dlv")).toBeUndefined()
		expect(result.find((a) => a.name === "js-debug")).toBeDefined()
	})

	it("returns empty when no markers are present", () => {
		setFiles([])
		setBinaries([])
		expect(detectMissingAdapters("/project")).toHaveLength(0)
	})

	it("surfaces multiple missing adapters for a polyglot project", () => {
		setFiles(["go.mod", "package.json", "pyproject.toml"])
		setBinaries([])
		const result = detectMissingAdapters("/project")
		expect(result.map((a) => a.name).sort()).toEqual(["debugpy", "dlv", "js-debug"])
	})
})

describe("adapterForFile", () => {
	const adapters = allAdapters()

	it("resolves .ts → js-debug", () => {
		expect(adapterForFile("/project/src/main.ts", adapters)?.name).toBe("js-debug")
	})

	it("resolves .tsx → js-debug", () => {
		expect(adapterForFile("/project/src/App.tsx", adapters)?.name).toBe("js-debug")
	})

	it("resolves .py → debugpy", () => {
		expect(adapterForFile("/project/app/main.py", adapters)?.name).toBe("debugpy")
	})

	it("resolves .go → dlv", () => {
		expect(adapterForFile("/project/cmd/main.go", adapters)?.name).toBe("dlv")
	})

	it("resolves .rs → lldb-dap", () => {
		expect(adapterForFile("/project/src/lib.rs", adapters)?.name).toBe("lldb-dap")
	})

	it("resolves .c → lldb-dap", () => {
		expect(adapterForFile("/project/src/main.c", adapters)?.name).toBe("lldb-dap")
	})

	it("resolves .cpp → lldb-dap", () => {
		expect(adapterForFile("/project/src/engine.cpp", adapters)?.name).toBe("lldb-dap")
	})

	it("returns null for an unknown extension", () => {
		expect(adapterForFile("/project/README.md", adapters)).toBeNull()
	})

	it("returns null for a file with no extension", () => {
		expect(adapterForFile("/project/Makefile", adapters)).toBeNull()
	})

	it("is case-insensitive on the extension", () => {
		expect(adapterForFile("/project/Main.TS", adapters)?.name).toBe("js-debug")
		expect(adapterForFile("/project/Main.GO", adapters)?.name).toBe("dlv")
	})
})

describe("adapterForLanguage", () => {
	const adapters = allAdapters()

	it("resolves typescript → js-debug", () => {
		expect(adapterForLanguage("typescript", adapters)?.name).toBe("js-debug")
	})

	it("resolves javascript → js-debug", () => {
		expect(adapterForLanguage("javascript", adapters)?.name).toBe("js-debug")
	})

	it("resolves python → debugpy", () => {
		expect(adapterForLanguage("python", adapters)?.name).toBe("debugpy")
	})

	it("resolves go → dlv", () => {
		expect(adapterForLanguage("go", adapters)?.name).toBe("dlv")
	})

	it("resolves rust → lldb-dap", () => {
		expect(adapterForLanguage("rust", adapters)?.name).toBe("lldb-dap")
	})

	it("resolves c → lldb-dap", () => {
		expect(adapterForLanguage("c", adapters)?.name).toBe("lldb-dap")
	})

	it("returns null for an unknown language", () => {
		expect(adapterForLanguage("haskell", adapters)).toBeNull()
	})

	it("is case-insensitive on the language id", () => {
		expect(adapterForLanguage("TypeScript", adapters)?.name).toBe("js-debug")
	})
})

describe("run_cmd prefix heuristic (detectBinary)", () => {
	// js-debug's command is `node` (always on PATH), but it is detected via
	// `js-debug-adapter` (the detectBinary shim) instead — so a machine with
	// node but NOT js-debug installed correctly reports js-debug as absent.
	it("detects js-debug via js-debug-adapter, NOT via node", () => {
		setFiles(["package.json"])
		// Only `js-debug-adapter` on PATH — `node` is NOT in the list.
		setBinaries(["js-debug-adapter"])
		const result = detectAdapters("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("js-debug")
	})

	it("does NOT detect js-debug when only `node` is on PATH (detectBinary=js-debug-adapter)", () => {
		setFiles(["package.json"])
		// `node` is on PATH but `js-debug-adapter` is not — js-debug must NOT
		// be detected, because detectBinary overrides command for the which check.
		setBinaries(["node"])
		const result = detectAdapters("/project")
		expect(result.find((a) => a.name === "js-debug")).toBeUndefined()
		// And it should surface as missing.
		const missing = detectMissingAdapters("/project")
		expect(missing.find((a) => a.name === "js-debug")).toBeDefined()
	})

	it("debugpy uses command as detectBinary (no override needed)", () => {
		setFiles(["pyproject.toml"])
		setBinaries(["debugpy"])
		expect(detectAdapters("/project")[0].name).toBe("debugpy")
	})

	it("dlv uses command as detectBinary (no override needed)", () => {
		setFiles(["go.mod"])
		setBinaries(["dlv"])
		expect(detectAdapters("/project")[0].name).toBe("dlv")
	})
})

describe("KIMCHI_DAP_BINARIES override", () => {
	// The override is read at module load (process.env.KIMCHI_DAP_BINARIES),
	// so each test resets modules and re-imports adapters.js with the env set.
	beforeEach(() => {
		vi.resetModules()
	})

	afterEach(() => {
		delete process.env.KIMCHI_DAP_BINARIES
		vi.resetModules()
	})

	it("uses the override whitelist instead of `which`", async () => {
		process.env.KIMCHI_DAP_BINARIES = "dlv"
		// Marker present; spawnSync should NOT be called (override short-circuits).
		const { detectAdapters } = await import("./adapters.js")
		// Re-establish the marker mock for the re-imported module.
		vi.mocked(fs.existsSync).mockImplementation(((p: unknown) => {
			return String(p) === "/project/go.mod"
		}) as never)
		const result = detectAdapters("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("dlv")
		expect(spawnSync).not.toHaveBeenCalled()
	})

	it("returns only adapters whose detectBinary is whitelisted", async () => {
		process.env.KIMCHI_DAP_BINARIES = "js-debug-adapter,debugpy"
		const { detectAdapters } = await import("./adapters.js")
		// Multiple markers present; only js-debug + debugpy whitelisted (not dlv).
		vi.mocked(fs.existsSync).mockImplementation(((p: unknown) => {
			const rel = String(p).replace(/^\/project\//, "")
			return ["go.mod", "package.json", "pyproject.toml"].includes(rel)
		}) as never)
		const result = detectAdapters("/project")
		expect(result.map((a) => a.name).sort()).toEqual(["debugpy", "js-debug"])
	})

	it("returns empty when override is set but no detectBinary is whitelisted", async () => {
		process.env.KIMCHI_DAP_BINARIES = ""
		const { detectAdapters } = await import("./adapters.js")
		vi.mocked(fs.existsSync).mockImplementation(((p: unknown) => {
			const rel = String(p).replace(/^\/project\//, "")
			return ["go.mod", "package.json"].includes(rel)
		}) as never)
		// Empty string → splits to [""] → matches no binary → all absent.
		expect(detectAdapters("/project")).toHaveLength(0)
		// And both surface as missing (markers present, binaries absent).
		const { detectMissingAdapters } = await import("./adapters.js")
		vi.mocked(fs.existsSync).mockImplementation(((p: unknown) => {
			const rel = String(p).replace(/^\/project\//, "")
			return ["go.mod", "package.json"].includes(rel)
		}) as never)
		const missing = detectMissingAdapters("/project")
		expect(missing.map((a) => a.name).sort()).toEqual(["dlv", "js-debug"])
	})
})
