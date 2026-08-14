import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock fs and child_process so we control marker-file presence and binary availability
vi.mock("node:fs", () => ({
	default: {
		existsSync: vi.fn(),
	},
}))

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}))

import { detectMissingCandidates, detectServers } from "./servers.js"

const mockExistsSync = vi.mocked(fs.existsSync)
const mockSpawnSync = vi.mocked(spawnSync)

// Suppress Bun global so exists() uses the spawnSync path
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

function setBinaries(onPath: string[]) {
	mockSpawnSync.mockImplementation(
		(_cmd: string, args?: readonly string[]) =>
			({
				status: onPath.includes(args?.[0] ?? "") ? 0 : 1,
			}) as never,
	)
}

describe("detectServers", () => {
	it("returns only servers whose marker AND binary are present", () => {
		setFiles(["go.mod"])
		setBinaries(["gopls", "typescript-language-server"])
		expect(detectServers("/project")).toHaveLength(1)
		expect(detectServers("/project")[0].name).toBe("gopls")
	})

	it("returns typescript-language-server when package.json present and binary on PATH", () => {
		setFiles(["package.json"])
		setBinaries(["typescript-language-server"])
		const result = detectServers("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("typescript-language-server")
	})

	it("returns empty when binary is on PATH but no marker file exists", () => {
		setFiles([])
		setBinaries(["gopls", "typescript-language-server"])
		expect(detectServers("/project")).toHaveLength(0)
	})

	it("returns empty when marker exists but binary is NOT on PATH", () => {
		setFiles(["go.mod"])
		setBinaries([])
		expect(detectServers("/project")).toHaveLength(0)
	})

	it("returns both servers when both markers and both binaries are present", () => {
		setFiles(["go.mod", "package.json"])
		setBinaries(["gopls", "typescript-language-server"])
		expect(detectServers("/project")).toHaveLength(2)
	})
})

describe("detectMissingCandidates", () => {
	it("returns gopls when go.mod present but gopls not on PATH", () => {
		setFiles(["go.mod"])
		setBinaries([])
		const result = detectMissingCandidates("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("gopls")
	})

	it("does NOT return typescript-language-server in a Go-only project", () => {
		setFiles(["go.mod"])
		setBinaries([])
		const result = detectMissingCandidates("/project")
		expect(result.find((s) => s.name === "typescript-language-server")).toBeUndefined()
	})

	it("returns typescript-language-server when package.json present but binary not on PATH", () => {
		setFiles(["package.json"])
		setBinaries([])
		const result = detectMissingCandidates("/project")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("typescript-language-server")
	})

	it("returns empty when no markers are present", () => {
		setFiles([])
		setBinaries([])
		expect(detectMissingCandidates("/project")).toHaveLength(0)
	})

	it("does not return a server whose binary IS on PATH", () => {
		setFiles(["go.mod", "package.json"])
		setBinaries(["gopls"])
		const result = detectMissingCandidates("/project")
		expect(result.find((s) => s.name === "gopls")).toBeUndefined()
		expect(result.find((s) => s.name === "typescript-language-server")).toBeDefined()
	})

	it("detects marker in a parent directory (monorepo subdirectory)", () => {
		// go.mod is in /project, but cwd is /project/services/autoscaler
		setFiles(["go.mod"])
		setBinaries([])
		mockExistsSync.mockImplementation(((p: unknown) => {
			// Only /project/go.mod exists, not /project/services/autoscaler/go.mod
			return String(p) === "/project/go.mod"
		}) as never)
		const result = detectMissingCandidates("/project/services/autoscaler")
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("gopls")
	})
})
