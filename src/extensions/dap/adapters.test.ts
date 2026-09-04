import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock fs and child_process so we control marker-file presence and binary
// availability — mirrors lsp/servers.test.ts exactly.
vi.mock("node:fs", () => ({
	default: {
		existsSync: vi.fn(),
		readdirSync: vi.fn(),
	},
}))

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}))

import {
	adapterForDirectory,
	adapterForFile,
	adapterForLanguage,
	allAdapters,
	detectAdapters,
	detectMissingAdapters,
	resolveJsDebugScript,
} from "./adapters.js"

const mockExistsSync = vi.mocked(fs.existsSync)
const mockReaddirSync = vi.mocked(fs.readdirSync)
const mockSpawnSync = vi.mocked(spawnSync)

// Suppress Bun global so exists() uses the spawnSync path (deterministic).
beforeEach(() => {
	mockExistsSync.mockReset()
	mockReaddirSync.mockReset()
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

/** `setBinaries` matches args?.[0] for `which` calls, and _cmd for direct
 *  spawn calls (e.g. `python3 -c "import debugpy"`). */
function setBinaries(onPath: string[]) {
	mockSpawnSync.mockImplementation((cmd: string, args?: readonly string[]) => {
		// `which <name>` → check if <name> is on the list
		if (cmd === "which" && onPath.includes(args?.[0] ?? "")) return { status: 0 } as never
		// Direct spawn (existsCmd) → check if cmd is on the list
		if (cmd !== "which" && onPath.includes(cmd)) return { status: 0 } as never
		return { status: 1 } as never
	})
}

/** Mock js-debug's detect() by making existsSync return true for
 *  dapDebugServer.js paths. */
function setJsDebugAvailable() {
	const original = mockExistsSync.getMockImplementation()
	mockExistsSync.mockImplementation(((p: unknown) => {
		if (String(p).includes("dapDebugServer.js")) return true
		return original ? original(p as fs.PathLike) : false
	}) as never)
}

describe("detectAdapters", () => {
	it("returns dlv when go.mod present and dlv binary on PATH", () => {
		setFiles(["go.mod"])
		setBinaries(["dlv"])
		const result = detectAdapters("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("dlv")
	})

	it("returns js-debug when package.json present and node + dapDebugServer.js available", () => {
		setFiles(["package.json"])
		// js-debug uses a custom detect() that checks for dapDebugServer.js
		// at known install paths. Mock existsSync to return true for it.
		mockExistsSync.mockImplementation(((p: unknown) => {
			return String(p).includes("dapDebugServer.js") || String(p) === "/project/package.json"
		}) as never)
		const result = detectAdapters("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("js-debug")
	})

	it("returns debugpy when pyproject.toml present and debugpy installed", () => {
		setFiles(["pyproject.toml"])
		setBinaries(["python3"])
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
		setBinaries(["dlv", "node", "python3", "lldb-dap"])
		setJsDebugAvailable()
		expect(detectAdapters("/project")).toHaveLength(0)
	})

	it("returns empty when marker exists but binary is NOT on PATH", () => {
		setFiles(["go.mod"])
		setBinaries([])
		expect(detectAdapters("/project")).toHaveLength(0)
	})

	it("returns multiple adapters when multiple markers and binaries are present", () => {
		setFiles(["go.mod", "package.json", "Cargo.toml"])
		setBinaries(["dlv", "lldb-dap"])
		setJsDebugAvailable()
		const result = detectAdapters("/project")
		expect(result.map((a) => a.name).sort()).toEqual(["dlv", "js-debug", "lldb-dap"])
	})

	it("does NOT return js-debug in a Go-only project even if node is on PATH", () => {
		setFiles(["go.mod"])
		setBinaries(["dlv"])
		setJsDebugAvailable()
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

	it("returns js-debug when package.json present but node not on PATH", () => {
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

describe("module-based detection (detectModule)", () => {
	// js-debug's command is `node` (always on PATH), but it is detected via
	// `detectModule` (node -e "require('fs').existsSync(...)") instead of
	// `which node` — so a machine with node but NOT dapDebugServer.js
	// correctly reports js-debug as absent.
	it("detects js-debug when node is available and dapDebugServer.js exists", () => {
		setFiles(["package.json"])
		// `node` on PATH and the detectModule script finds the file.
		setBinaries(["node"])
		// The detectModule script checks existsSync for the path — mock it
		// to return true for the js-debug script path.
		const original = mockExistsSync.getMockImplementation()
		mockExistsSync.mockImplementation(((p: unknown) => {
			const s = String(p)
			if (s.includes("dapDebugServer.js")) return true
			return original ? original(p as fs.PathLike) : false
		}) as never)
		const result = detectAdapters("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("js-debug")
	})

	it("does NOT detect js-debug when dapDebugServer.js is absent", () => {
		setFiles(["package.json"])
		// node is on PATH but dapDebugServer.js is not at any install path.
		// existsSync returns false for dapDebugServer.js paths.
		setBinaries(["node"])
		const result = detectAdapters("/project")
		expect(result.find((a) => a.name === "js-debug")).toBeUndefined()
		// And it should surface as missing.
		const missing = detectMissingAdapters("/project")
		expect(missing.find((a) => a.name === "js-debug")).toBeDefined()
	})

	it("debugpy uses detectModule (python3 -c import debugpy)", () => {
		setFiles(["pyproject.toml"])
		setBinaries(["python3"])
		expect(detectAdapters("/project")[0].name).toBe("debugpy")
	})

	it("dlv uses command as detectBinary (no override needed)", () => {
		setFiles(["go.mod"])
		setBinaries(["dlv"])
		expect(detectAdapters("/project")[0].name).toBe("dlv")
	})
})

describe("resolveJsDebugScript JS_DEBUG_PATH validation", () => {
	afterEach(() => {
		delete process.env.JS_DEBUG_PATH
	})

	it("honors JS_DEBUG_PATH only when the file exists", () => {
		process.env.JS_DEBUG_PATH = "/opt/js-debug/src/dapDebugServer.js"
		mockExistsSync.mockImplementation(((p: unknown) => String(p) === "/opt/js-debug/src/dapDebugServer.js") as never)
		expect(resolveJsDebugScript()).toBe("/opt/js-debug/src/dapDebugServer.js")
	})

	it("ignores JS_DEBUG_PATH when the file does not exist", () => {
		// Regression: a stale/typo'd JS_DEBUG_PATH previously marked the adapter
		// as installed, and the spawn of `node <path>` failed only much later
		// inside client.ts.
		process.env.JS_DEBUG_PATH = "/opt/js-debug/WRONG-PATH/dapDebugServer.js"
		mockExistsSync.mockImplementation((() => false) as never)
		expect(resolveJsDebugScript()).toBeNull()
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

	it("returns only adapters whose detection is whitelisted", async () => {
		// Override whitelist is adapter NAMES uniformly: "debugpy" (the adapter
		// name) whitelists the module-based adapter, not "python3" (the argv[0]
		// of its detectModule check).
		process.env.KIMCHI_DAP_BINARIES = "js-debug,debugpy"
		const { detectAdapters } = await import("./adapters.js")
		// Multiple markers present; only js-debug + debugpy whitelisted (not dlv).
		vi.mocked(fs.existsSync).mockImplementation(((p: unknown) => {
			const rel = String(p).replace(/^\/project\//, "")
			return ["go.mod", "package.json", "pyproject.toml"].includes(rel)
		}) as never)
		const result = detectAdapters("/project")
		expect(result.map((a) => a.name).sort()).toEqual(["debugpy", "js-debug"])
	})

	it("does not whitelist module-based adapters by their detectModule argv[0]", async () => {
		// Regression: the override key is the adapter name. "python3" is only
		// the executor of the module check ({ python3 -c "import debugpy" }) and
		// must NOT activate debugpy on its own.
		process.env.KIMCHI_DAP_BINARIES = "python3"
		const { detectAdapters } = await import("./adapters.js")
		vi.mocked(fs.existsSync).mockImplementation(((p: unknown) => {
			return String(p) === "/project/pyproject.toml"
		}) as never)
		const result = detectAdapters("/project")
		expect(result.map((a) => a.name)).toEqual([])
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

// =============================================================================
// adapterForDirectory — language detection from directory contents
// =============================================================================

describe("adapterForDirectory", () => {
	it("detects Go via .go files", () => {
		mockReaddirSync.mockReturnValue(["main.go", "go.sum"] as never)
		expect(adapterForDirectory("/proj", allAdapters())?.name).toBe("dlv")
	})

	it("detects Python via .py files", () => {
		mockReaddirSync.mockReturnValue(["app.py"] as never)
		expect(adapterForDirectory("/proj", allAdapters())?.name).toBe("debugpy")
	})

	it("detects TypeScript/JavaScript via .ts/.js files", () => {
		mockReaddirSync.mockReturnValue(["index.ts", "package.json"] as never)
		expect(adapterForDirectory("/proj", allAdapters())?.name).toBe("js-debug")
	})

	it("detects native via .c/.rs sources next to a compiled binary", () => {
		// The extensionless `main` binary itself matches nothing; its sibling
		// source drives detection (the compiled-binary fallback).
		mockReaddirSync.mockReturnValue(["main.c", "main"] as never)
		expect(adapterForDirectory("/proj", allAdapters())?.name).toBe("lldb-dap")
	})

	it("prefers go over python when both are present (documented priority order)", () => {
		mockReaddirSync.mockReturnValue(["main.go", "app.py"] as never)
		expect(adapterForDirectory("/proj", allAdapters())?.name).toBe("dlv")
	})

	it("returns null when no supported sources are present", () => {
		mockReaddirSync.mockReturnValue(["README.md", "binary"] as never)
		expect(adapterForDirectory("/proj", allAdapters())).toBeNull()
	})

	it("detects Swift via .swift (full extension arrays, not a hard-coded subset)", () => {
		// Regression: the pre-fix detector only hard-coded .ts/.js/.rs/.c/.cpp,
		// so a binary next to main.swift silently failed detection. Detection
		// now consults every adapter's declared `extensions` array.
		mockReaddirSync.mockReturnValue(["main", "main.swift"] as never)
		expect(adapterForDirectory("/proj", allAdapters())?.name).toBe("lldb-dap")
	})

	it("detects TypeScript via .tsx/.jsx variants", () => {
		mockReaddirSync.mockReturnValue(["App.tsx", "component.jsx"] as never)
		expect(adapterForDirectory("/proj", allAdapters())?.name).toBe("js-debug")
	})

	it("detects C++ via .cc/.cxx variants", () => {
		mockReaddirSync.mockReturnValue(["main", "main.cxx"] as never)
		expect(adapterForDirectory("/proj", allAdapters())?.name).toBe("lldb-dap")
	})

	it("returns null for a non-directory path (readdirSync throws)", () => {
		mockReaddirSync.mockImplementation((() => {
			throw new Error("ENOTDIR")
		}) as never)
		expect(adapterForDirectory("/proj", allAdapters())).toBeNull()
	})
})
