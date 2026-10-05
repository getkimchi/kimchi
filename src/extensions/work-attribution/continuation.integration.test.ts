import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { getWorkId } from "../work-attribution.js"
import { findWorkContinuation } from "./continuation.js"
import { createTrackedWriteTool } from "./file-transitions.js"
import { flushWorkSummaries } from "./summary.js"

let root: string | undefined
afterEach(async () => {
	await flushWorkSummaries()
	vi.unstubAllEnvs()
	if (root) rmSync(root, { recursive: true, force: true })
})

it("continues a skill-written ADR by its recorded file or recent branch without native plan mode", async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-skill-work-")))
	const cwd = join(root, "repo")
	mkdirSync(cwd)
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
	git("init", "-q", "-b", "trunk")
	git("config", "user.name", "Continuation Test")
	git("config", "user.email", "continuation@example.invalid")
	git("config", "commit.gpgSign", "false")
	git("commit", "-q", "--allow-empty", "-m", "Baseline")
	git("update-ref", "refs/remotes/origin/trunk", "HEAD")
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
	git("checkout", "-q", "-b", "feature")
	const ctx = createContext({ cwd, sessionManager: { getSessionId: () => "skill-planner" } })
	const path = "docs/adr/decision.md"
	await createTrackedWriteTool(ctx, "write-adr").execute("write-adr", { path, content: "# Build the feature\n" })
	const workId = getWorkId(ctx)
	expect(await findWorkContinuation({ cwd }, `/skill:implement ${path}`)).toMatchObject({
		workId,
		source: "named-artifact",
		evidence: { path: join(cwd, path), branch: "feature" },
	})
	expect(await findWorkContinuation({ cwd }, "/skill:implement", { allowBranchFallback: true })).toMatchObject({
		workId,
		source: "recent-branch",
		evidence: { path: join(cwd, path), branch: "feature" },
	})
	git("add", path)
	git("commit", "-q", "-m", "Save the ADR")
	const otherTree = join(root, "implementation")
	git("worktree", "add", "-q", "-b", "implementation", otherTree)
	expect(await findWorkContinuation({ cwd: otherTree }, `Implement ${path}`)).toMatchObject({
		workId,
		source: "named-artifact",
		evidence: { path: join(otherTree, path), worktree: cwd },
	})
	expect(
		await findWorkContinuation({ cwd: otherTree }, "/skill:implement", { allowBranchFallback: true }),
	).toBeUndefined()
	writeFileSync(join(otherTree, path), "# Different work\n")
	expect(await findWorkContinuation({ cwd: otherTree }, `Implement ${path}`)).toBeUndefined()
})
