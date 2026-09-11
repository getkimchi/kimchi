import type { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadWorkspaceFile, WORKSPACE_FILE_NAME, WorkspaceFileError } from "./workspace-file.js"

let repoRoot: string
let outsideDir: string

/** execFile stub that answers `git rev-parse --show-toplevel` for the fixture repo; throws elsewhere. */
function gitExecReturning(root: string): typeof execFileSync {
	return vi.fn((_cmd: string, args?: readonly string[]) => {
		if (args?.includes("--show-toplevel")) return `${root}\n`
		throw new Error("unexpected git call")
	}) as unknown as typeof execFileSync
}

const gitExecFailing = vi.fn(() => {
	throw new Error("not a git repository")
}) as unknown as typeof execFileSync

function writeWorkspaceFile(dir: string, content: string): string {
	const path = join(dir, WORKSPACE_FILE_NAME)
	writeFileSync(path, content)
	return path
}

beforeEach(() => {
	repoRoot = mkdtempSync(join(tmpdir(), "workspace-file-repo-"))
	outsideDir = mkdtempSync(join(tmpdir(), "workspace-file-outside-"))
})

afterEach(() => {
	rmSync(repoRoot, { recursive: true, force: true })
	rmSync(outsideDir, { recursive: true, force: true })
})

describe("loadWorkspaceFile discovery", () => {
	it("finds the file at cwd (cwd == repo root)", () => {
		writeWorkspaceFile(repoRoot, "resources:\n  cpu: 250m\n")
		const cfg = loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })
		expect(cfg).toEqual({ resources: { cpu: "250m" } })
	})

	it("walks up from a nested subdir to the repo root", () => {
		writeWorkspaceFile(repoRoot, "resources:\n  memory: 1Gi\n")
		const nested = join(repoRoot, "packages", "app")
		mkdirSync(nested, { recursive: true })
		const cfg = loadWorkspaceFile(nested, { execFile: gitExecReturning(repoRoot) })
		expect(cfg).toEqual({ resources: { memory: "1Gi" } })
	})

	it("uses the nearest file when several exist up the tree", () => {
		writeWorkspaceFile(repoRoot, "resources:\n  cpu: 100m\n")
		const nested = join(repoRoot, "sub")
		mkdirSync(nested)
		writeWorkspaceFile(nested, "resources:\n  cpu: 999m\n")
		const cfg = loadWorkspaceFile(join(nested), { execFile: gitExecReturning(repoRoot) })
		expect(cfg).toEqual({ resources: { cpu: "999m" } })
	})

	it("never looks above the repo root", () => {
		// File lives in the *parent* of the repo root — must not be picked up.
		writeWorkspaceFile(outsideDir, "resources:\n  cpu: 500m\n")
		const nestedRepo = join(outsideDir, "repo")
		mkdirSync(nestedRepo)
		const cfg = loadWorkspaceFile(nestedRepo, { execFile: gitExecReturning(nestedRepo) })
		expect(cfg).toBeUndefined()
	})

	it("checks only cwd outside a git repo", () => {
		writeWorkspaceFile(outsideDir, "resources:\n  pvcSize: 20Gi\n")
		expect(loadWorkspaceFile(outsideDir, { execFile: gitExecFailing })).toEqual({
			resources: { pvcSize: "20Gi" },
		})
		const child = join(outsideDir, "child")
		mkdirSync(child)
		expect(loadWorkspaceFile(child, { execFile: gitExecFailing })).toBeUndefined()
	})

	it("returns undefined when no file exists", () => {
		expect(loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })).toBeUndefined()
	})
})

describe("loadWorkspaceFile parsing", () => {
	it("extracts cpu/memory/pvcSize string values", () => {
		writeWorkspaceFile(repoRoot, "resources:\n  cpu: 250m\n  memory: 1Gi\n  pvcSize: 20Gi\n")
		const cfg = loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })
		expect(cfg).toEqual({ resources: { cpu: "250m", memory: "1Gi", pvcSize: "20Gi" } })
	})

	it("ignores unknown top-level sections", () => {
		writeWorkspaceFile(repoRoot, "resources:\n  cpu: 250m\nunknown-section:\n  x: 1\n")
		const cfg = loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })
		expect(cfg).toEqual({ resources: { cpu: "250m" } })
	})

	it("throws WorkspaceFileError naming the field for a non-string value (unquoted YAML number)", () => {
		writeWorkspaceFile(repoRoot, "resources:\n  cpu: 250\n")
		try {
			loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })
			expect.unreachable()
		} catch (err) {
			expect(err).toBeInstanceOf(WorkspaceFileError)
			expect((err as Error).message).toContain('"cpu"')
			expect((err as Error).message).toContain("Quote the value")
		}
	})

	it("throws WorkspaceFileError naming an unknown key under resources", () => {
		writeWorkspaceFile(repoRoot, "resources:\n  ram: 1Gi\n")
		try {
			loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })
			expect.unreachable()
		} catch (err) {
			expect(err).toBeInstanceOf(WorkspaceFileError)
			expect((err as Error).message).toContain('"ram"')
			expect((err as Error).message).toContain("cpu, memory, pvcSize")
		}
	})

	it("throws WorkspaceFileError when resources is not a mapping", () => {
		writeWorkspaceFile(repoRoot, "resources: 5\n")
		expect(() => loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })).toThrowError(WorkspaceFileError)
	})

	it("returns {} when the resources mapping is empty", () => {
		writeWorkspaceFile(repoRoot, "resources: {}\n")
		const cfg = loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })
		expect(cfg).toEqual({})
	})

	it("passes quantities through unvalidated (validation is the resolver's job)", () => {
		writeWorkspaceFile(repoRoot, "resources:\n  cpu: 250 m\n")
		const cfg = loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })
		expect(cfg).toEqual({ resources: { cpu: "250 m" } })
	})

	it("throws WorkspaceFileError on malformed YAML, naming the file", () => {
		const path = writeWorkspaceFile(repoRoot, "resources:\n  cpu: [unclosed\n")
		expect(() => loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })).toThrowError(WorkspaceFileError)
		try {
			loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })
		} catch (err) {
			expect(err).toBeInstanceOf(WorkspaceFileError)
			// loadWorkspaceFile realpaths the start dir (macOS /var → /private/var).
			expect((err as WorkspaceFileError).filePath).toBe(realpathSync(path))
			expect((err as Error).message).toContain(WORKSPACE_FILE_NAME)
		}
	})

	it("throws WorkspaceFileError when the top level is not a mapping", () => {
		writeWorkspaceFile(repoRoot, "- just\n- a\n- list\n")
		expect(() => loadWorkspaceFile(repoRoot, { execFile: gitExecReturning(repoRoot) })).toThrowError(WorkspaceFileError)
	})
})
