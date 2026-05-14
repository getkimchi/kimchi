import { describe, expect, it, vi } from "vitest"
import { GitHubClient, type Repo, assetName } from "./github.js"

const REPO: Repo = { owner: "castai", name: "kimchi-dev", binary: "kimchi" }

describe("assetName", () => {
	it("formats `<binary>_<os>_<arch>.tar.gz` on Linux/macOS", () => {
		const orig = process.platform
		Object.defineProperty(process, "platform", { value: "linux" })
		Object.defineProperty(process, "arch", { value: "x64" })
		try {
			expect(assetName(REPO)).toBe("kimchi_linux_amd64.tar.gz")
		} finally {
			Object.defineProperty(process, "platform", { value: orig })
		}
	})

	it("uses .zip on Windows (different release format)", () => {
		const origPlat = process.platform
		const origArch = process.arch
		Object.defineProperty(process, "platform", { value: "win32" })
		Object.defineProperty(process, "arch", { value: "x64" })
		try {
			expect(assetName(REPO)).toBe("kimchi_windows_amd64.zip")
		} finally {
			Object.defineProperty(process, "platform", { value: origPlat })
			Object.defineProperty(process, "arch", { value: origArch })
		}
	})
})

describe("GitHubClient.latestRelease", () => {
	it("parses tag_name + html_url out of the API response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ tag_name: "v1.2.3", html_url: "https://github.com/x/y/releases/tag/v1.2.3" }),
		}) as unknown as typeof fetch
		const client = new GitHubClient({ fetch: fetchImpl })
		const got = await client.latestRelease(REPO)
		expect(got.tagName).toBe("v1.2.3")
		expect(got.htmlUrl).toBe("https://github.com/x/y/releases/tag/v1.2.3")
	})

	it("throws on non-200 response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch
		const client = new GitHubClient({ fetch: fetchImpl })
		await expect(client.latestRelease(REPO)).rejects.toThrow(/404/)
	})

	it("throws when tag_name is missing", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ html_url: "..." }),
		}) as unknown as typeof fetch
		const client = new GitHubClient({ fetch: fetchImpl })
		await expect(client.latestRelease(REPO)).rejects.toThrow(/tag_name/)
	})
})

describe("GitHubClient.canaryRelease", () => {
	it("parses tag_name + target_commitish + name out of the API response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				tag_name: "canary",
				target_commitish: "abc1234abc1234abc1234abc1234abc1234abc12",
				html_url: "https://github.com/x/y/releases/tag/canary",
				name: "Canary 0.0.0-canary.20260509.abc1234",
			}),
		}) as unknown as typeof fetch
		const client = new GitHubClient({ fetch: fetchImpl })
		const got = await client.canaryRelease(REPO)
		expect(got.tagName).toBe("canary")
		expect(got.targetCommitish).toBe("abc1234abc1234abc1234abc1234abc1234abc12")
		expect(got.htmlUrl).toBe("https://github.com/x/y/releases/tag/canary")
		expect(got.name).toBe("Canary 0.0.0-canary.20260509.abc1234")
	})

	it("throws on non-200 response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch
		const client = new GitHubClient({ fetch: fetchImpl })
		await expect(client.canaryRelease(REPO)).rejects.toThrow(/404/)
	})

	it("throws when target_commitish is missing", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ tag_name: "canary", html_url: "..." }),
		}) as unknown as typeof fetch
		const client = new GitHubClient({ fetch: fetchImpl })
		await expect(client.canaryRelease(REPO)).rejects.toThrow(/target_commitish/)
	})
})

describe("GitHubClient.fetchChecksum", () => {
	it("finds the checksum line for our platform's asset", async () => {
		const origPlat = process.platform
		Object.defineProperty(process, "platform", { value: "linux" })
		Object.defineProperty(process, "arch", { value: "x64" })

		// Two-line checksums.txt; we want the first hex string parsed back to bytes.
		const text = [
			"9999999999999999999999999999999999999999999999999999999999999999  kimchi_darwin_arm64.tar.gz",
			"deadbeef00000000000000000000000000000000000000000000000000000000  kimchi_linux_amd64.tar.gz",
		].join("\n")
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => text,
		}) as unknown as typeof fetch
		try {
			const client = new GitHubClient({ fetch: fetchImpl })
			const sum = await client.fetchChecksum(REPO, "v1.0.0")
			expect(Buffer.from(sum).toString("hex")).toBe("deadbeef00000000000000000000000000000000000000000000000000000000")
		} finally {
			Object.defineProperty(process, "platform", { value: origPlat })
		}
	})

	it("throws when our asset isn't listed", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => "0000  kimchi_other_other.tar.gz\n",
		}) as unknown as typeof fetch
		const client = new GitHubClient({ fetch: fetchImpl })
		await expect(client.fetchChecksum(REPO, "v1.0.0")).rejects.toThrow(/checksum not found/)
	})
})
