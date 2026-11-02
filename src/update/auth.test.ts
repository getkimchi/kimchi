import { afterEach, describe, expect, it, vi } from "vitest"
import { resetGithubTokenCache, resolveGithubToken } from "./auth.js"

afterEach(() => {
	resetGithubTokenCache()
})

describe("resolveGithubToken", () => {
	it("prefers GITHUB_TOKEN from the environment", async () => {
		const ghCli = vi.fn(async () => "gho_from_cli")
		const token = await resolveGithubToken({ GITHUB_TOKEN: "ghp_env" }, ghCli)
		expect(token).toBe("ghp_env")
		expect(ghCli).not.toHaveBeenCalled()
	})

	it("falls back to GH_TOKEN when GITHUB_TOKEN is unset", async () => {
		const token = await resolveGithubToken({ GH_TOKEN: "ghp_gh_env" }, async () => undefined)
		expect(token).toBe("ghp_gh_env")
	})

	it("treats an empty env value as unset and asks the gh CLI", async () => {
		const token = await resolveGithubToken({ GITHUB_TOKEN: "  " }, async () => "gho_from_cli")
		expect(token).toBe("gho_from_cli")
	})

	it("trims whitespace around the env value", async () => {
		const token = await resolveGithubToken({ GITHUB_TOKEN: "  ghp_env  \n" }, async () => undefined)
		expect(token).toBe("ghp_env")
	})

	it("falls back to the gh CLI when no env token is set", async () => {
		const token = await resolveGithubToken({}, async () => "gho_from_cli")
		expect(token).toBe("gho_from_cli")
	})

	it("returns undefined when the gh CLI yields nothing", async () => {
		const token = await resolveGithubToken({}, async () => undefined)
		expect(token).toBe(undefined)
	})

	it("caches the resolution for the process lifetime (one gh spawn at most)", async () => {
		const ghCli = vi.fn(async () => "gho_from_cli")
		await resolveGithubToken({}, ghCli)
		const again = await resolveGithubToken({ GITHUB_TOKEN: "ghp_env" }, async () => "other")
		expect(again).toBe("gho_from_cli")
		expect(ghCli).toHaveBeenCalledTimes(1)
	})

	it("honors a new environment after resetGithubTokenCache", async () => {
		await resolveGithubToken({}, async () => "gho_from_cli")
		resetGithubTokenCache()
		const token = await resolveGithubToken({ GITHUB_TOKEN: "ghp_env" }, async () => undefined)
		expect(token).toBe("ghp_env")
	})
})
