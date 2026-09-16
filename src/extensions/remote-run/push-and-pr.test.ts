import type { execFileSync } from "node:child_process"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	classifyPushFailure,
	createDraftPr,
	manualPrCommand,
	pushBranchRemotely,
	pushViaLocalFallback,
	scanDiffForSecrets,
} from "./push-and-pr.js"
import { runSandboxGit, SandboxGitError } from "./sandbox-git.js"

vi.mock("./sandbox-git.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sandbox-git.js")>()
	return { ...actual, runSandboxGit: vi.fn() }
})

vi.mock("../../config.js", () => ({
	loadConfig: () => ({ apiKey: "test-key" }),
}))

const CONNECTION = { host: "worker.example.com", remoteUser: "sandbox", authToken: "tok", cwd: "/home/sandbox/acp-x" }

beforeEach(() => {
	vi.clearAllMocks()
})

describe("scanDiffForSecrets", () => {
	it("returns no hits for typical source code", () => {
		const patch = [
			"diff --git a/src/auth.ts b/src/auth.ts",
			"--- a/src/auth.ts",
			"+++ b/src/auth.ts",
			"@@ -1,3 +1,4 @@",
			"+export function checkSkill(user: User) {",
			"+  // skin deeply nested scopes; ask later",
			"+  return user.scopes.includes('admin')",
			"+}",
		].join("\n")
		expect(scanDiffForSecrets(patch)).toEqual([])
	})

	it("flags every curated true-positive format with redacted evidence lines", () => {
		const cases: Array<{ content: string; pattern: string; forbidden: string }> = [
			{
				content: "-----BEGIN OPENSSH PRIVATE KEY-----",
				pattern: "private key block",
				forbidden: "-----BEGIN OPENSSH PRIVATE KEY-----x",
			},
			{ content: "aws_key = AKIAIOSFODNN7EXAMPLE", pattern: "AWS access key id", forbidden: "AKIAIOSFODNN7EXAMPLE" },
			{
				content: `token=ghp_${"a".repeat(36)}`,
				pattern: "GitHub personal access token",
				forbidden: `ghp_${"a".repeat(36)}`,
			},
			{
				content: `tok=github_pat_${"b".repeat(30)}`,
				pattern: "GitHub personal access token",
				forbidden: `github_pat_${"b".repeat(30)}`,
			},
			{
				content: `tok=glpat-${"c".repeat(24)}`,
				pattern: "GitLab personal access token",
				forbidden: `glpat-${"c".repeat(24)}`,
			},
			{
				content: `apiKey: "sk-${"d".repeat(48)}"`,
				pattern: "OpenAI-style API key",
				forbidden: `sk-${"d".repeat(48)}`,
			},
			{
				content: `key: "AIza${"e".repeat(35)}"`,
				pattern: "Google API key",
				forbidden: `AIza${"e".repeat(35)}`,
			},
			{
				content: `tok=xoxb-${"f".repeat(12)}`,
				pattern: "Slack token",
				forbidden: `xoxb-${"f".repeat(12)}`,
			},
		]
		for (const { content, pattern, forbidden } of cases) {
			const patch = `diff --git a/.env b/.env\n+++ b/.env\n+${content}\n`
			const hits = scanDiffForSecrets(patch)
			expect(hits, content).toHaveLength(1)
			expect(hits[0]?.pattern).toBe(pattern)
			expect(hits[0]?.line, "secret must be redacted in evidence").not.toContain(forbidden)
			expect(hits[0]?.lineNumber).toBe(3)
		}
	})

	it("ignores removed (-) lines and the +++ header line", () => {
		const patch = [
			"diff --git a/.env b/.env",
			"--- a/.env",
			`+++ b/.env AKIAIOSFODNN7EXAMPLE`,
			`-aws_key = AKIAIOSFODNN7EXAMPLE`,
			"+aws_key = <redacted>",
		].join("\n")
		expect(scanDiffForSecrets(patch)).toEqual([])
	})
})

describe("classifyPushFailure", () => {
	it("maps the known stderr shapes", () => {
		expect(classifyPushFailure("! [rejected] main -> main (non-fast-forward)").kind).toBe("non-fast-forward")
		expect(classifyPushFailure("error: failed to push some refs — hint: fetch first").kind).toBe("non-fast-forward")
		expect(classifyPushFailure("git@github.com: Permission denied (publickey).").kind).toBe("auth")
		expect(classifyPushFailure("remote: Invalid username or password. Authentication failed").kind).toBe("auth")
		expect(classifyPushFailure("fatal: unable to access 'https://x': The requested URL returned error: 403").kind).toBe(
			"auth",
		)
		expect(classifyPushFailure("ssh: connect to host x port 22: Connection refused").kind).toBe("transport")
		expect(classifyPushFailure("ssh: Could not resolve hostname x: Name or service not known").kind).toBe("transport")
		expect(classifyPushFailure("something totally unexpected").kind).toBe("unknown")
	})

	it("auth classification points at the local fallback explicitly", () => {
		const failure = classifyPushFailure("Permission denied (publickey).")
		expect(failure.reason).toContain("local fallback")
	})
})

describe("pushBranchRemotely", () => {
	it("pushes -u origin <branch> via runSandboxGit and reports ok", async () => {
		vi.mocked(runSandboxGit).mockResolvedValue({ stdout: "", stderr: "" })

		const result = await pushBranchRemotely({ connection: CONNECTION, branch: "kimchi/fix" })

		expect(result).toEqual({ ok: true })
		expect(vi.mocked(runSandboxGit)).toHaveBeenCalledWith(
			expect.objectContaining({ connection: CONNECTION, args: ["push", "-u", "origin", "kimchi/fix"] }),
		)
	})

	it("classifies a rejected push instead of throwing", async () => {
		vi.mocked(runSandboxGit).mockRejectedValue(
			new SandboxGitError(128, "remote: Permission to repo denied\nfatal: unable to access 'https://x': 403"),
		)

		const result = await pushBranchRemotely({ connection: CONNECTION, branch: "kimchi/fix" })

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.failure.kind).toBe("auth")
	})
})

describe("pushViaLocalFallback", () => {
	it("fetches into refs/kimchi-push/<branch> via GIT_SSH_COMMAND then pushes with ambient env", async () => {
		const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined; cwd: string | undefined }> =
			[]
		const execFile = vi.fn((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
			calls.push({ cmd, args, env: opts.env, cwd: opts.cwd })
			return Buffer.from("")
		}) as unknown as typeof execFileSync

		const result = await pushViaLocalFallback({
			connection: CONNECTION,
			branch: "kimchi/fix",
			localRepo: "/repo",
			execFile,
		})

		expect(result).toEqual({ ok: true })
		expect(calls).toHaveLength(3)

		// Fetch: into the staging ref only — never refs/heads, never the worktree.
		expect(calls[0]?.args[0]).toBe("fetch")
		expect(calls[0]?.args[1]).toBe("--no-tags")
		expect(calls[0]?.args[2]).toBe("ssh://sandbox@worker.example.com/home/sandbox/acp-x")
		expect(calls[0]?.args[3]).toBe("+refs/heads/kimchi/fix:refs/kimchi-push/kimchi/fix")
		expect(calls[0]?.cwd).toBe("/repo")
		const fetchSsh = calls[0]?.env?.GIT_SSH_COMMAND ?? ""
		expect(fetchSsh).toContain("ProxyCommand=")
		expect(fetchSsh).toContain("BatchMode=yes")
		expect(calls[0]?.env?.AUTH_TOKEN).toBe("tok")
		expect(calls[0]?.env?.KIMCHI_API_KEY).toBe("test-key")

		// Push: staging ref onto the real branch, ambient env (no GIT_SSH_COMMAND override).
		expect(calls[1]?.args).toEqual(["push", "-u", "origin", "refs/kimchi-push/kimchi/fix:refs/heads/kimchi/fix"])
		expect(calls[1]?.env).toBeUndefined()

		// The staging ref is deleted after the push — never left in the user's repo.
		expect(calls[2]?.args).toEqual(["update-ref", "-d", "refs/kimchi-push/kimchi/fix"])
	})

	it("deletes the staging ref even when the local push fails", async () => {
		const calls: string[][] = []
		const execFile = vi.fn((_cmd: string, args: string[]) => {
			calls.push(args)
			if (args[0] === "push") {
				throw Object.assign(new Error("push failed"), { stderr: Buffer.from("! [rejected] (non-fast-forward)") })
			}
			return Buffer.from("")
		}) as unknown as typeof execFileSync

		const result = await pushViaLocalFallback({
			connection: CONNECTION,
			branch: "kimchi/fix",
			localRepo: "/repo",
			execFile,
		})

		expect(result.ok).toBe(false)
		expect(calls[2]).toEqual(["update-ref", "-d", "refs/kimchi-push/kimchi/fix"])
	})

	it("classifies a local push rejection", async () => {
		const failure = Object.assign(new Error("push failed"), {
			stderr: Buffer.from("! [rejected] refs/heads/kimchi/fix (non-fast-forward)"),
		})
		const execFile = vi.fn((_cmd: string, args: string[]) => {
			if (args[0] === "push") throw failure
			return Buffer.from("")
		}) as unknown as typeof execFileSync

		const result = await pushViaLocalFallback({
			connection: CONNECTION,
			branch: "kimchi/fix",
			localRepo: "/repo",
			execFile,
		})

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.failure.kind).toBe("non-fast-forward")
	})
})

describe("createDraftPr", () => {
	it("returns the PR URL gh prints", () => {
		const execFile = vi.fn(() =>
			Buffer.from("https://github.com/getkimchi/kimchi/pull/42\n"),
		) as unknown as typeof execFileSync

		const result = createDraftPr({
			localRepo: "/repo",
			branch: "kimchi/fix",
			baseBranch: "main",
			title: "Fix the login redirect",
			body: "Run summary",
			execFile,
		})

		expect(result).toEqual({ kind: "created", url: "https://github.com/getkimchi/kimchi/pull/42" })
		expect(execFile).toHaveBeenCalledWith(
			"gh",
			[
				"pr",
				"create",
				"--draft",
				"--head",
				"kimchi/fix",
				"--base",
				"main",
				"--title",
				"Fix the login redirect",
				"--body",
				"Run summary",
			],
			expect.objectContaining({ cwd: "/repo" }),
		)
	})

	it("omits --base when baseBranch is undefined", () => {
		const captured: string[][] = []
		const execFile = vi.fn((_cmd: string, args: string[]) => {
			captured.push(args)
			return Buffer.from("https://github.com/x/y/pull/1\n")
		}) as unknown as typeof execFileSync

		createDraftPr({ localRepo: "/repo", branch: "b", title: "t", body: "", execFile })
		expect(captured[0]).not.toContain("--base")
	})

	it("returns the manual command when gh is missing (ENOENT)", () => {
		const execFile = vi.fn(() => {
			throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })
		}) as unknown as typeof execFileSync

		const result = createDraftPr({ localRepo: "/repo", branch: "kimchi/fix", title: "Fix login", body: "s", execFile })

		expect(result.kind).toBe("manual")
		if (result.kind === "manual") {
			expect(result.reason).toContain("gh CLI is not installed")
			expect(result.command).toBe(manualPrCommand({ branch: "kimchi/fix", title: "Fix login" }))
		}
	})

	it("returns the manual command when gh is unauthenticated", () => {
		const execFile = vi.fn(() => {
			throw Object.assign(new Error("gh failed"), {
				stderr: Buffer.from("To get started with GitHub CLI, please run: gh auth login"),
			})
		}) as unknown as typeof execFileSync

		const result = createDraftPr({ localRepo: "/repo", branch: "b", title: "t", body: "", execFile })

		expect(result.kind).toBe("manual")
		if (result.kind === "manual") expect(result.reason).toContain("gh auth login")
	})

	it("returns the manual command when gh prints no URL", () => {
		const execFile = vi.fn(() => Buffer.from("Creating draft pull request…\n")) as unknown as typeof execFileSync

		const result = createDraftPr({ localRepo: "/repo", branch: "b", title: "t", body: "", execFile })

		expect(result.kind).toBe("manual")
		if (result.kind === "manual") expect(result.reason).toContain("no PR URL")
	})
})
