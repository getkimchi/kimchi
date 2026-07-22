import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock fs and child_process so we control marker-file presence and binary availability
vi.mock("node:fs", () => ({
	default: {
		existsSync: vi.fn(),
		statSync: vi.fn(),
		readFileSync: vi.fn(),
	},
}))

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}))

import { detectMissingCandidates, detectServers, findMainRepoRoot, resolveTsserverPath } from "./servers.js"

const mockExistsSync = vi.mocked(fs.existsSync)
const mockSpawnSync = vi.mocked(spawnSync)
const mockStatSync = vi.mocked(fs.statSync)
const mockReadFileSync = vi.mocked(fs.readFileSync)

// Suppress Bun global so exists() uses the spawnSync path
beforeEach(() => {
	mockExistsSync.mockReset()
	mockSpawnSync.mockReset()
	mockStatSync.mockReset()
	mockReadFileSync.mockReset()
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

describe("findMainRepoRoot", () => {
	it("returns main repo path when .git is a file with valid gitdir line", () => {
		const cwd = "/worktree/foo"
		const dotGit = `${cwd}/.git`
		mockExistsSync.mockImplementation((p: unknown) => p === dotGit)
		mockStatSync.mockReturnValue({ isDirectory: () => false } as unknown as fs.Stats)
		mockReadFileSync.mockReturnValue("gitdir: /main-repo/.git/worktrees/foo\n")
		expect(findMainRepoRoot(cwd)).toBe("/main-repo")
	})

	it("returns undefined when .git is a directory", () => {
		const cwd = "/normal-repo"
		const dotGit = `${cwd}/.git`
		mockExistsSync.mockImplementation((p: unknown) => p === dotGit)
		mockStatSync.mockReturnValue({ isDirectory: () => true } as unknown as fs.Stats)
		expect(findMainRepoRoot(cwd)).toBeUndefined()
	})

	it("returns undefined when .git doesn't exist", () => {
		mockExistsSync.mockReturnValue(false)
		expect(findMainRepoRoot("/no-git")).toBeUndefined()
	})

	it("returns undefined when .git content doesn't match gitdir pattern", () => {
		const cwd = "/weird"
		const dotGit = `${cwd}/.git`
		mockExistsSync.mockImplementation((p: unknown) => p === dotGit)
		mockStatSync.mockReturnValue({ isDirectory: () => false } as unknown as fs.Stats)
		mockReadFileSync.mockReturnValue("this is not a gitdir file\n")
		expect(findMainRepoRoot(cwd)).toBeUndefined()
	})

	it("returns undefined when gitdir doesn't match worktrees pattern", () => {
		const cwd = "/submodule"
		const dotGit = `${cwd}/.git`
		mockExistsSync.mockImplementation((p: unknown) => p === dotGit)
		mockStatSync.mockReturnValue({ isDirectory: () => false } as unknown as fs.Stats)
		mockReadFileSync.mockReturnValue("gitdir: /other-repo/.git/modules/foo\n")
		expect(findMainRepoRoot(cwd)).toBeUndefined()
	})
})

describe("resolveTsserverPath", () => {
	const localTsserver = "/cwd/node_modules/typescript/lib/tsserver.js"
	const mainTsserver = "/main-repo/node_modules/typescript/lib/tsserver.js"

	beforeEach(() => {
		mockStatSync.mockReturnValue({ isDirectory: () => false } as unknown as fs.Stats)
		mockReadFileSync.mockReturnValue("gitdir: /main-repo/.git/worktrees/cwd\n")
	})

	it("returns local tsserver.js when node_modules/typescript exists in cwd", () => {
		mockExistsSync.mockImplementation((p: unknown) => p === localTsserver)
		expect(resolveTsserverPath("/cwd")).toBe(localTsserver)
	})

	it("returns main repo tsserver.js when cwd is a worktree without local node_modules", () => {
		const dotGit = "/cwd/.git"
		mockExistsSync.mockImplementation((p: unknown) => p === dotGit || p === mainTsserver)
		expect(resolveTsserverPath("/cwd")).toBe(mainTsserver)
	})

	it("returns undefined when not in a worktree and no local TypeScript", () => {
		// .git doesn't exist -> findMainRepoRoot returns undefined early
		mockExistsSync.mockReturnValue(false)
		expect(resolveTsserverPath("/cwd")).toBeUndefined()
	})

	it("returns undefined when .git is a directory and no local TypeScript", () => {
		const dotGit = "/cwd/.git"
		mockExistsSync.mockImplementation((p: unknown) => p === dotGit)
		mockStatSync.mockReturnValue({ isDirectory: () => true } as unknown as fs.Stats)
		expect(resolveTsserverPath("/cwd")).toBeUndefined()
	})

	it("prefers local over main repo when both exist", () => {
		const dotGit = "/cwd/.git"
		mockExistsSync.mockImplementation((p: unknown) => p === localTsserver || p === dotGit || p === mainTsserver)
		expect(resolveTsserverPath("/cwd")).toBe(localTsserver)
	})
})
