import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "shell-quote"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolvePreMainProjectTrust } from "../../project-trust.js"
import { createToolContext } from "../__mocks__/context.js"
import { acquirePRLease, checkoutProblem, preparePRCheckout } from "./checkout.js"
import { readPRSource } from "./providers.js"
import type { PRSnapshot } from "./types.js"

vi.mock("../../project-trust.js", () => ({ resolvePreMainProjectTrust: vi.fn() }))
vi.mock("./providers.js", () => ({ readPRSource: vi.fn() }))

const signal = () => new AbortController().signal
let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kimchi-pr-checkout-"))
})
afterEach(() => {
	rmSync(root, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

describe("auto-fix checkout guard", () => {
	let pr: PRSnapshot
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim()
	beforeEach(() => {
		git("init", "-b", "feature")
		git("config", "user.name", "PR fixture")
		git("config", "user.email", "fixture@example.invalid")
		git("config", "commit.gpgSign", "false")
		writeFileSync(join(root, "hello.txt"), "hello\n")
		git("add", "hello.txt")
		git("commit", "-m", "fixture")
		pr = {
			provider: "github",
			repository: "owner/repo",
			number: 1,
			title: "Fixture",
			url: "https://github.com/owner/repo/pull/1",
			branch: "feature",
			headSha: git("rev-parse", "HEAD"),
			state: "open",
			checks: [],
			feedback: [],
		}
	})
	it("allows only a clean checkout of the exact remote head", async () => {
		expect(await checkoutProblem(root, pr, signal())).toBeNull()
		writeFileSync(join(root, "untracked.txt"), "unfinished\n")
		expect(await checkoutProblem(root, pr, signal())).toContain("local changes")
	})
	it("refuses another branch with the same commit, unpublished commits and detached heads", async () => {
		expect(await checkoutProblem(root, { ...pr, headSha: "0".repeat(40) }, signal())).toContain("differs")
		git("switch", "-c", "other")
		expect(await checkoutProblem(root, pr, signal())).toContain("branch changed")
		git("checkout", "--detach")
		expect(await checkoutProblem(root, pr, signal())).toContain("branch changed")
	})
})

describe("PR checkout preparation", () => {
	const url = "https://github.com/owner/repo/pull/7"
	beforeEach(() => {
		vi.resetAllMocks()
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))
		vi.mocked(resolvePreMainProjectTrust).mockReturnValue(true)
		vi.mocked(readPRSource).mockResolvedValue({
			url,
			provider: "github",
			state: "open",
			branch: "fix",
			cloneURL: "https://github.com/author/fork.git",
		})
	})
	const clone = (isError: boolean, text: string) => ({
		toolCall: { type: "toolCall" as const, id: "clone", name: "bash", arguments: {} },
		result: { content: [{ type: "text" as const, text }], details: {} },
		isError,
	})

	it("clones the source branch only through permission-checked Bash", async () => {
		const ctx = createToolContext({ cwd: root })
		vi.mocked(ctx.executeTool).mockResolvedValue(clone(false, "cloned"))
		const cwd = await preparePRCheckout(ctx, url, signal())
		expect(cwd).toContain(join("pr-watch", "checkouts"))
		const input = vi.mocked(ctx.executeTool).mock.calls[0][1] as { command: string }
		expect(parse(input.command)).toEqual([
			"gh",
			"repo",
			"clone",
			"https://github.com/author/fork.git",
			cwd,
			"--",
			"--single-branch",
			"--branch",
			"fix",
		])
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
	})

	it("reports a denied clone without asking for trust", async () => {
		const ctx = createToolContext({ cwd: root })
		vi.mocked(ctx.executeTool).mockResolvedValue(clone(true, "Permission denied"))
		await expect(preparePRCheckout(ctx, url, signal())).rejects.toThrow("Permission denied")
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
	})

	it("asks before trusting an existing checkout for fixes, and not for watching", async () => {
		mkdirSync(join(root, ".git"))
		const ctx = createToolContext({ cwd: root, isProjectTrusted: vi.fn(() => true) })
		vi.mocked(resolvePreMainProjectTrust).mockReturnValue(false)
		vi.mocked(ctx.ui.confirm).mockResolvedValue(false)
		await expect(preparePRCheckout(ctx, url, signal(), root)).rejects.toThrow("Trust")
		expect(ctx.executeTool).not.toHaveBeenCalled()
		await expect(preparePRCheckout(ctx, url, signal(), root, false)).resolves.toBe(root)
	})
})

describe("PR repair lease", () => {
	it("lets one holder repair a PR until it releases the lease", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))
		const pr = { url: "https://github.com/owner/repo/pull/7" } as PRSnapshot
		const release = await acquirePRLease(pr, vi.fn())
		await expect(acquirePRLease(pr, vi.fn())).rejects.toMatchObject({ code: "ELOCKED" })
		await release()
		const again = await acquirePRLease(pr, vi.fn())
		await again()
	})
})
