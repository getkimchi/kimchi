import { describe, expect, it } from "vitest"
import { type GetGitRemoteHostOptions, getGitRemoteHost, parseHostFromRemoteUrl } from "./git-credentials.js"

describe("parseHostFromRemoteUrl", () => {
	it("parses HTTPS URL", () => {
		expect(parseHostFromRemoteUrl("https://github.com/org/repo.git")).toBe("github.com")
	})

	it("parses HTTPS URL without .git suffix", () => {
		expect(parseHostFromRemoteUrl("https://github.com/org/repo")).toBe("github.com")
	})

	it("parses HTTPS URL with user info", () => {
		expect(parseHostFromRemoteUrl("https://user@gitlab.com/a/b.git")).toBe("gitlab.com")
	})

	it("parses SSH shorthand (git@host:path)", () => {
		expect(parseHostFromRemoteUrl("git@github.com:org/repo.git")).toBe("github.com")
	})

	it("parses SSH shorthand with custom user", () => {
		expect(parseHostFromRemoteUrl("deploy@bitbucket.org:team/project.git")).toBe("bitbucket.org")
	})

	it("parses ssh:// URL", () => {
		expect(parseHostFromRemoteUrl("ssh://git@github.com/org/repo")).toBe("github.com")
	})

	it("parses git:// URL", () => {
		expect(parseHostFromRemoteUrl("git://example.com/repo.git")).toBe("example.com")
	})

	it("handles URL with port", () => {
		expect(parseHostFromRemoteUrl("https://gitlab.internal.io:8443/group/repo.git")).toBe("gitlab.internal.io")
	})

	it("handles SSH shorthand with subdomain", () => {
		expect(parseHostFromRemoteUrl("git@git.company.com:infra/deploy.git")).toBe("git.company.com")
	})

	it("returns undefined for empty string", () => {
		expect(parseHostFromRemoteUrl("")).toBeUndefined()
	})

	it("returns undefined for whitespace-only", () => {
		expect(parseHostFromRemoteUrl("   ")).toBeUndefined()
	})

	it("returns undefined for garbage input", () => {
		expect(parseHostFromRemoteUrl("not-a-url-at-all")).toBeUndefined()
	})

	it("trims trailing newline from git output", () => {
		expect(parseHostFromRemoteUrl("https://github.com/org/repo.git\n")).toBe("github.com")
	})
})

describe("getGitRemoteHost", () => {
	// Helper to create a mock exec that satisfies the type signature.
	// The real exec returns PromiseWithChild but we only need stdout/stderr or throw.
	const mockExec = (fn: () => Promise<{ stdout: string; stderr: string }>) =>
		fn as unknown as NonNullable<GetGitRemoteHostOptions["exec"]>

	it("returns the host when git succeeds", async () => {
		const exec = mockExec(async () => ({ stdout: "https://github.com/org/repo.git\n", stderr: "" }))
		const host = await getGitRemoteHost("/fake/path", { exec })
		expect(host).toBe("github.com")
	})

	it("returns undefined when git fails (not a repo)", async () => {
		const exec = mockExec(async () => {
			throw new Error("fatal: not a git repository")
		})
		const host = await getGitRemoteHost("/fake/path", { exec })
		expect(host).toBeUndefined()
	})

	it("returns undefined when git returns empty stdout", async () => {
		const exec = mockExec(async () => ({ stdout: "", stderr: "" }))
		const host = await getGitRemoteHost("/fake/path", { exec })
		expect(host).toBeUndefined()
	})

	it("returns SSH host from git output", async () => {
		const exec = mockExec(async () => ({ stdout: "git@gitlab.com:team/project.git\n", stderr: "" }))
		const host = await getGitRemoteHost("/fake/path", { exec })
		expect(host).toBe("gitlab.com")
	})
})
