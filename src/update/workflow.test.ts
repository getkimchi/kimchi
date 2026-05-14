import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CanaryReleaseInfo, GitHubClient, ReleaseInfo, Repo } from "./github.js"
import { checkForUpdate, parseCanarySha7 } from "./workflow.js"

const REPO: Repo = { owner: "castai", name: "kimchi-dev", binary: "kimchi" }

function fakeClient(release: ReleaseInfo): GitHubClient {
	return {
		latestRelease: async () => release,
	} as unknown as GitHubClient
}

function fakeCanaryClient(release: CanaryReleaseInfo): GitHubClient {
	return {
		canaryRelease: async () => release,
	} as unknown as GitHubClient
}

describe("checkForUpdate version comparison", () => {
	let tmp: string
	let prevHome: string | undefined
	let prevXdg: string | undefined

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "kimchi-workflow-test-"))
		prevHome = process.env.HOME
		prevXdg = process.env.XDG_CACHE_HOME
		process.env.XDG_CACHE_HOME = tmp
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		// biome-ignore lint/performance/noDelete: same as above.
		if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME
		else process.env.XDG_CACHE_HOME = prevXdg
		rmSync(tmp, { recursive: true, force: true })
	})

	it("does not flag a v-prefixed older tag as an update", async () => {
		const client = fakeClient({ tagName: "v0.0.23", htmlUrl: "https://example/release" })
		const result = await checkForUpdate({ repo: REPO, currentVersion: "0.1.0", skipCache: true, client })
		expect(result.hasUpdate).toBe(false)
		// display string keeps the "v" — only the comparison should be normalized
		expect(result.latestVersion).toBe("v0.0.23")
	})

	it("flags a v-prefixed newer tag as an update", async () => {
		const client = fakeClient({ tagName: "v0.2.0", htmlUrl: "https://example/release" })
		const result = await checkForUpdate({ repo: REPO, currentVersion: "0.1.0", skipCache: true, client })
		expect(result.hasUpdate).toBe(true)
	})

	it("still works for an unprefixed newer tag", async () => {
		const client = fakeClient({ tagName: "0.2.0", htmlUrl: "https://example/release" })
		const result = await checkForUpdate({ repo: REPO, currentVersion: "0.1.0", skipCache: true, client })
		expect(result.hasUpdate).toBe(true)
	})

	it("stable path returns the tag for downloads", async () => {
		const client = fakeClient({ tagName: "v0.2.0", htmlUrl: "https://example/release" })
		const result = await checkForUpdate({ repo: REPO, currentVersion: "0.1.0", skipCache: true, client })
		expect(result.tag).toBe("v0.2.0")
		expect(result.latestVersion).toBe("v0.2.0")
	})
})

describe("checkForUpdate canary path", () => {
	let tmp: string
	let prevHome: string | undefined
	let prevXdg: string | undefined

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "kimchi-workflow-canary-test-"))
		prevHome = process.env.HOME
		prevXdg = process.env.XDG_CACHE_HOME
		process.env.XDG_CACHE_HOME = tmp
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		// biome-ignore lint/performance/noDelete: same as above.
		if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME
		else process.env.XDG_CACHE_HOME = prevXdg
		rmSync(tmp, { recursive: true, force: true })
	})

	it("returns the canary tag for downloads and the version parsed from the title", async () => {
		const client = fakeCanaryClient({
			tagName: "canary",
			targetCommitish: "abc1234abc1234abc1234abc1234abc1234abc12",
			htmlUrl: "https://example/canary",
			name: "Canary 0.0.0-canary.20260509.abc1234",
		})
		const result = await checkForUpdate({ repo: REPO, currentVersion: "0.1.0", canary: true, client })
		expect(result.tag).toBe("canary")
		expect(result.latestVersion).toBe("0.0.0-canary.20260509.abc1234")
		expect(result.hasUpdate).toBe(true)
		expect(result.releaseUrl).toBe("https://example/canary")
		expect(result.cached).toBe(false)
	})

	it("falls back to the tag when the release title is missing", async () => {
		const client = fakeCanaryClient({
			tagName: "canary",
			targetCommitish: "abc1234abc1234abc1234abc1234abc1234abc12",
			htmlUrl: "",
			name: "",
		})
		const result = await checkForUpdate({ repo: REPO, currentVersion: "0.1.0", canary: true, client })
		expect(result.latestVersion).toBe("canary")
	})

	it("reports already-current when local SHA7 matches targetCommitish", async () => {
		const client = fakeCanaryClient({
			tagName: "canary",
			targetCommitish: "abc1234abc1234abc1234abc1234abc1234abc12",
			htmlUrl: "https://example/canary",
			name: "Canary 0.0.0-canary.20260509.abc1234",
		})
		const result = await checkForUpdate({
			repo: REPO,
			currentVersion: "0.0.0-canary.20260509.abc1234",
			canary: true,
			client,
		})
		expect(result.hasUpdate).toBe(false)
	})

	it("reports an update when local SHA7 differs from targetCommitish", async () => {
		const client = fakeCanaryClient({
			tagName: "canary",
			targetCommitish: "def5678def5678def5678def5678def5678def56",
			htmlUrl: "https://example/canary",
			name: "Canary 0.0.0-canary.20260509.def5678",
		})
		const result = await checkForUpdate({
			repo: REPO,
			currentVersion: "0.0.0-canary.20260508.abc1234",
			canary: true,
			client,
		})
		expect(result.hasUpdate).toBe(true)
	})

	it("treats date-only difference (same SHA) as already current", async () => {
		// Two canaries can land on the same UTC day; matching SHA wins
		// regardless of date stamp drift.
		const client = fakeCanaryClient({
			tagName: "canary",
			targetCommitish: "abc1234abc1234abc1234abc1234abc1234abc12",
			htmlUrl: "https://example/canary",
			name: "Canary 0.0.0-canary.20260510.abc1234",
		})
		const result = await checkForUpdate({
			repo: REPO,
			currentVersion: "0.0.0-canary.20260509.abc1234",
			canary: true,
			client,
		})
		expect(result.hasUpdate).toBe(false)
	})

	it("treats a non-hex targetCommitish (branch name) as update available", async () => {
		// gh release create --target "$GITHUB_SHA" guarantees a SHA today, but
		// targetCommitish is whatever was passed and could be a branch like
		// "master". Don't silently match the junk prefix.
		const client = fakeCanaryClient({
			tagName: "canary",
			targetCommitish: "master",
			htmlUrl: "https://example/canary",
			name: "Canary 0.0.0-canary.20260509.mastert",
		})
		const result = await checkForUpdate({
			repo: REPO,
			currentVersion: "0.0.0-canary.20260509.mastert",
			canary: true,
			client,
		})
		expect(result.hasUpdate).toBe(true)
	})

	it("treats a non-canary local as update available under --canary", async () => {
		const client = fakeCanaryClient({
			tagName: "canary",
			targetCommitish: "abc1234abc1234abc1234abc1234abc1234abc12",
			htmlUrl: "https://example/canary",
			name: "Canary 0.0.0-canary.20260509.abc1234",
		})
		const result = await checkForUpdate({ repo: REPO, currentVersion: "0.1.0", canary: true, client })
		expect(result.hasUpdate).toBe(true)
	})
})

describe("checkForUpdate: bare update from a canary install", () => {
	it("flags stable as an update when local is a canary build (0.0.0-* < any stable)", async () => {
		const client = fakeClient({ tagName: "v0.0.23", htmlUrl: "https://example/release" })
		const result = await checkForUpdate({
			repo: REPO,
			currentVersion: "0.0.0-canary.20260509.abc1234",
			skipCache: true,
			client,
		})
		expect(result.hasUpdate).toBe(true)
		expect(result.tag).toBe("v0.0.23")
	})
})

describe("parseCanarySha7", () => {
	it("extracts the SHA7 from a well-formed canary version", () => {
		expect(parseCanarySha7("0.0.0-canary.20260509.abc1234")).toBe("abc1234")
	})

	it("returns null for a stable version", () => {
		expect(parseCanarySha7("0.1.0")).toBeNull()
		expect(parseCanarySha7("v0.0.23")).toBeNull()
	})

	it("returns null for a malformed canary version", () => {
		// uppercase hex
		expect(parseCanarySha7("0.0.0-canary.20260509.ABC1234")).toBeNull()
		// SHA too short
		expect(parseCanarySha7("0.0.0-canary.20260509.abc123")).toBeNull()
		// SHA too long
		expect(parseCanarySha7("0.0.0-canary.20260509.abc12345")).toBeNull()
		// date wrong length
		expect(parseCanarySha7("0.0.0-canary.2026050.abc1234")).toBeNull()
		// trailing garbage
		expect(parseCanarySha7("0.0.0-canary.20260509.abc1234-dirty")).toBeNull()
		// empty / unrelated
		expect(parseCanarySha7("")).toBeNull()
		expect(parseCanarySha7("canary")).toBeNull()
	})
})
