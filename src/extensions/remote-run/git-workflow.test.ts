import type { execFileSync } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import {
	CUSTOM_BRANCH_ITEM,
	CUSTOM_BRANCH_PROMPT,
	isValidBranchName,
	MAX_SLUG_LENGTH,
	promptForRemoteBranch,
	REMOTE_BRANCH_PROMPT,
	resolveBaseBranch,
	resolveLocalBranch,
	slugifyPlanBranch,
} from "./git-workflow.js"

type ExecFileSync = typeof execFileSync

function gitExecReturning(output: string): ExecFileSync {
	return vi.fn().mockReturnValue(output) as unknown as ExecFileSync
}

describe("slugifyPlanBranch", () => {
	it("derives a slug from the Goal section first line", () => {
		expect(slugifyPlanBranch("## Goal\nBuild a feature\n\n## Chunks\n### Chunk 1\nDo something")).toBe(
			"kimchi-build-a-feature",
		)
	})

	it("lowercases and dasherizes mixed case and punctuation", () => {
		expect(slugifyPlanBranch("## Goal\nAdd PR-First Remote Flow!")).toBe("kimchi-add-pr-first-remote-flow")
	})

	it("skips blank lines between the Goal header and the text", () => {
		expect(slugifyPlanBranch("## Goal\n\n\nReal goal here")).toBe("kimchi-real-goal-here")
	})

	it("falls back to kimchi-plan when there is no Goal section", () => {
		expect(slugifyPlanBranch("# Some other doc\nNo goal heading")).toBe("kimchi-plan")
	})

	it("falls back to kimchi-plan when the Goal section is empty", () => {
		expect(slugifyPlanBranch("## Goal\n## Constraints\nNothing")).toBe("kimchi-plan")
	})

	it("falls back to kimchi-plan when the goal has no usable ASCII characters", () => {
		expect(slugifyPlanBranch("## Goal\n기능 추가해주세요")).toBe("kimchi-plan")
		expect(slugifyPlanBranch("## Goal\n🚀🚀🚀")).toBe("kimchi-plan")
	})

	it("strips diacritics", () => {
		expect(slugifyPlanBranch("## Goal\nDéploiement rapide")).toBe("kimchi-deploiement-rapide")
	})

	it("caps the slug at MAX_SLUG_LENGTH without a trailing dash", () => {
		const longGoal = `## Goal\n${"abcdefghijklmnopqrstuvwxyz ".repeat(10)}`
		const slug = slugifyPlanBranch(longGoal).slice("kimchi-".length)
		expect(slug.length).toBe(MAX_SLUG_LENGTH)
		expect(slug.endsWith("-")).toBe(false)
		expect(slug).toMatch(/^[a-z0-9-]+$/)
	})

	it("handles windows line endings", () => {
		expect(slugifyPlanBranch("## Goal\r\nFix login bug\r\n\r\n## Chunks")).toBe("kimchi-fix-login-bug")
	})
})

describe("resolveBaseBranch", () => {
	const ctx = { cwd: "/repo" }

	it("strips the origin/ prefix from the symref target", () => {
		const exec = gitExecReturning("origin/main\n")
		expect(resolveBaseBranch(ctx, { _execFileSync: exec })).toBe("main")
	})

	it("returns non-default branches too", () => {
		const exec = gitExecReturning("origin/trunk")
		expect(resolveBaseBranch(ctx, { _execFileSync: exec })).toBe("trunk")
	})

	it("queries the fixed origin/HEAD symref in ctx.cwd", () => {
		const exec = gitExecReturning("origin/main")
		resolveBaseBranch(ctx, { _execFileSync: exec })
		expect(exec).toHaveBeenCalledWith(
			"git",
			["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
			expect.objectContaining({ cwd: "/repo" }),
		)
	})

	it("returns undefined when the output lacks the origin/ prefix", () => {
		const exec = gitExecReturning("main")
		expect(resolveBaseBranch(ctx, { _execFileSync: exec })).toBeUndefined()
	})

	it("returns undefined when git fails (no origin remote, no symref)", () => {
		const exec = vi.fn().mockImplementation(() => {
			throw new Error("not a git repository")
		}) as unknown as ExecFileSync
		expect(resolveBaseBranch(ctx, { _execFileSync: exec })).toBeUndefined()
	})

	it("returns undefined for an empty symref target", () => {
		const exec = gitExecReturning("origin/")
		expect(resolveBaseBranch(ctx, { _execFileSync: exec })).toBeUndefined()
	})
})

describe("resolveLocalBranch", () => {
	const ctx = { cwd: "/repo" }

	it("returns the checked-out branch name", () => {
		const exec = gitExecReturning("feature/rate-limits\n")
		expect(resolveLocalBranch(ctx, { _execFileSync: exec })).toBe("feature/rate-limits")
	})

	it("queries rev-parse --abbrev-ref HEAD in ctx.cwd", () => {
		const exec = gitExecReturning("main")
		resolveLocalBranch(ctx, { _execFileSync: exec })
		expect(exec).toHaveBeenCalledWith(
			"git",
			["rev-parse", "--abbrev-ref", "HEAD"],
			expect.objectContaining({ cwd: "/repo" }),
		)
	})

	it("returns undefined on a detached HEAD (git prints HEAD)", () => {
		const exec = gitExecReturning("HEAD")
		expect(resolveLocalBranch(ctx, { _execFileSync: exec })).toBeUndefined()
	})

	it("returns undefined when git fails (not a repo, no commits)", () => {
		const exec = vi.fn().mockImplementation(() => {
			throw new Error("not a git repository")
		}) as unknown as ExecFileSync
		expect(resolveLocalBranch(ctx, { _execFileSync: exec })).toBeUndefined()
	})
})

describe("isValidBranchName", () => {
	it("accepts ordinary and namespaced branch names", () => {
		expect(isValidBranchName("main")).toBe(true)
		expect(isValidBranchName("kimchi/add-rate-limits")).toBe(true)
		expect(isValidBranchName("user.name/feature_v2")).toBe(true)
	})

	it("rejects empty and whitespace-containing names", () => {
		expect(isValidBranchName("")).toBe(false)
		expect(isValidBranchName("has space")).toBe(false)
	})

	it("rejects git-forbidden sequences and characters", () => {
		expect(isValidBranchName("a..b")).toBe(false)
		expect(isValidBranchName("a//b")).toBe(false)
		expect(isValidBranchName("a@{b")).toBe(false)
		expect(isValidBranchName("what?")).toBe(false)
		expect(isValidBranchName("a*b")).toBe(false)
		expect(isValidBranchName("a[b")).toBe(false)
		expect(isValidBranchName("a~1")).toBe(false)
		expect(isValidBranchName("a^2")).toBe(false)
	})

	it("rejects bad component edges", () => {
		expect(isValidBranchName("-leading-dash")).toBe(false)
		expect(isValidBranchName("/leading-slash")).toBe(false)
		expect(isValidBranchName("trailing-slash/")).toBe(false)
		expect(isValidBranchName("trailing-dot.")).toBe(false)
		expect(isValidBranchName(".hidden")).toBe(false)
		expect(isValidBranchName("kimchi/.hidden")).toBe(false)
		expect(isValidBranchName("foo.lock")).toBe(false)
	})
})

describe("promptForRemoteBranch", () => {
	it("accepts the suggested slug picked from the menu", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("kimchi/suggested")
		const result = await promptForRemoteBranch(ctx, "kimchi/suggested", {
			_resolveBaseBranch: () => "main",
		})
		expect(ctx.ui.select).toHaveBeenCalledWith(REMOTE_BRANCH_PROMPT, ["kimchi/suggested", CUSTOM_BRANCH_ITEM])
		expect(ctx.ui.input).not.toHaveBeenCalled()
		expect(result).toEqual({ branch: "kimchi/suggested", baseBranch: "main" })
	})

	it("resolves the base branch from the local clone when no resolver is injected", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("kimchi/suggested")
		// No origin in /tmp — resolution fails honestly instead of blowing up.
		const result = await promptForRemoteBranch(ctx, "kimchi/suggested")
		expect(result).toEqual({ branch: "kimchi/suggested", baseBranch: undefined })
	})

	it("trims surrounding whitespace from a custom name", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOM_BRANCH_ITEM)
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("  kimchi/my-branch  ")
		const result = await promptForRemoteBranch(ctx, "kimchi/suggested", { _resolveBaseBranch: () => "main" })
		expect(result?.branch).toBe("kimchi/my-branch")
	})

	it("yields a plain run on Escape at the picker without prompting for a name", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
		expect(await promptForRemoteBranch(ctx, "kimchi/suggested", { _resolveBaseBranch: () => "main" })).toBeUndefined()
		expect(ctx.ui.input).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("yields a plain run on an empty custom-name submit", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOM_BRANCH_ITEM)
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("   ")
		expect(await promptForRemoteBranch(ctx, "kimchi/suggested", { _resolveBaseBranch: () => "main" })).toBeUndefined()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("lists the local feature branch as a second menu item and accepts it", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("feature/rate-limits")
		const result = await promptForRemoteBranch(ctx, "kimchi/suggested", {
			_resolveBaseBranch: () => "main",
			_resolveLocalBranch: () => "feature/rate-limits",
		})
		expect(ctx.ui.select).toHaveBeenCalledWith(REMOTE_BRANCH_PROMPT, [
			"kimchi/suggested",
			"feature/rate-limits",
			CUSTOM_BRANCH_ITEM,
		])
		expect(ctx.ui.input).not.toHaveBeenCalled()
		expect(result).toEqual({ branch: "feature/rate-limits", baseBranch: "main" })
	})

	it("defaults to plain run in headless mode without prompting", async () => {
		const ctx = createContext({ hasUI: false })
		expect(await promptForRemoteBranch(ctx, "kimchi/suggested")).toBeUndefined()
		expect(ctx.ui.select).not.toHaveBeenCalled()
		expect(ctx.ui.input).not.toHaveBeenCalled()
	})

	it("defaults to plain run outside tui mode without prompting", async () => {
		const ctx = createContext({ mode: "print" })
		expect(await promptForRemoteBranch(ctx, "kimchi/suggested")).toBeUndefined()
		expect(ctx.ui.select).not.toHaveBeenCalled()
		expect(ctx.ui.input).not.toHaveBeenCalled()
	})

	it("omits the local branch item on main", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
		await promptForRemoteBranch(ctx, "kimchi/suggested", {
			_resolveBaseBranch: () => "main",
			_resolveLocalBranch: () => "main",
		})
		expect(ctx.ui.select).toHaveBeenCalledWith(REMOTE_BRANCH_PROMPT, ["kimchi/suggested", CUSTOM_BRANCH_ITEM])
	})

	it("omits the local branch item on master", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
		await promptForRemoteBranch(ctx, "kimchi/suggested", {
			_resolveBaseBranch: () => "main",
			_resolveLocalBranch: () => "master",
		})
		expect(ctx.ui.select).toHaveBeenCalledWith(REMOTE_BRANCH_PROMPT, ["kimchi/suggested", CUSTOM_BRANCH_ITEM])
	})

	it("dedupes the local branch item when it equals the slug", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
		await promptForRemoteBranch(ctx, "kimchi/suggested", {
			_resolveBaseBranch: () => "main",
			_resolveLocalBranch: () => "kimchi/suggested",
		})
		expect(ctx.ui.select).toHaveBeenCalledWith(REMOTE_BRANCH_PROMPT, ["kimchi/suggested", CUSTOM_BRANCH_ITEM])
	})

	it("omits the local branch item when it is unresolvable (detached HEAD or not a repo)", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
		await promptForRemoteBranch(ctx, "kimchi/suggested", {
			_resolveBaseBranch: () => "main",
			_resolveLocalBranch: () => undefined,
		})
		expect(ctx.ui.select).toHaveBeenCalledWith(REMOTE_BRANCH_PROMPT, ["kimchi/suggested", CUSTOM_BRANCH_ITEM])
	})

	it("rejects an invalid custom name with a warning and falls back to plain run", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOM_BRANCH_ITEM)
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("bad..name")
		const result = await promptForRemoteBranch(ctx, "kimchi/suggested", { _resolveBaseBranch: () => "main" })
		expect(ctx.ui.input).toHaveBeenCalledWith(CUSTOM_BRANCH_PROMPT, "kimchi/suggested")
		expect(result).toBeUndefined()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not a valid git branch name"), "warning")
	})

	it("accepts a custom name via the free-text input", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOM_BRANCH_ITEM)
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue("kimchi/my-branch")
		const result = await promptForRemoteBranch(ctx, "kimchi/suggested", { _resolveBaseBranch: () => "main" })
		expect(result).toEqual({ branch: "kimchi/my-branch", baseBranch: "main" })
	})

	it("yields a plain run without a warning on Escape in the custom-name input", async () => {
		const ctx = createContext()
		;(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOM_BRANCH_ITEM)
		;(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
		expect(await promptForRemoteBranch(ctx, "kimchi/suggested", { _resolveBaseBranch: () => "main" })).toBeUndefined()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})
})
