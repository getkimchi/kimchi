import { afterEach, describe, expect, it, vi } from "vitest"
import { isInSandboxCluster } from "./sandbox.js"

vi.mock("node:os", () => ({
	homedir: vi.fn(),
	userInfo: vi.fn(),
}))

import { homedir, userInfo } from "node:os"

describe("isInSandboxCluster", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.mocked(homedir).mockReset()
		vi.mocked(userInfo).mockReset()
	})

	it("returns true when KIMCHI_SANDBOX=1", () => {
		vi.stubEnv("KIMCHI_SANDBOX", "1")
		expect(isInSandboxCluster()).toBe(true)
	})

	it("returns true when KIMCHI_SANDBOX=true (case-insensitive)", () => {
		vi.stubEnv("KIMCHI_SANDBOX", "true")
		expect(isInSandboxCluster()).toBe(true)
	})

	it("returns false when KIMCHI_SANDBOX is not a truthy value", () => {
		vi.stubEnv("KIMCHI_SANDBOX", "0")
		expect(isInSandboxCluster()).toBe(false)
	})

	it("returns false when no sandbox signals are present", () => {
		expect(isInSandboxCluster()).toBe(false)
	})

	it("prioritises KIMCHI_SANDBOX over security-fallback signals", () => {
		vi.stubEnv("KIMCHI_SANDBOX", "1")
		expect(isInSandboxCluster()).toBe(true)
	})

	// ─── Security fallback tests ─────────────────────────────────────────────

	it("returns true when both homedir and username match sandbox signals", () => {
		vi.mocked(homedir).mockReturnValue("/home/sandbox")
		vi.mocked(userInfo).mockReturnValue({
			username: "sandbox",
			uid: 1000,
			gid: 1000,
			shell: "/bin/bash",
			homedir: "/home/sandbox",
		})
		expect(isInSandboxCluster()).toBe(true)
	})

	it("returns false when only homedir matches but username does not", () => {
		vi.mocked(homedir).mockReturnValue("/home/sandbox")
		vi.mocked(userInfo).mockReturnValue({
			username: "alice",
			uid: 1000,
			gid: 1000,
			shell: "/bin/bash",
			homedir: "/home/sandbox",
		})
		expect(isInSandboxCluster()).toBe(false)
	})

	it("returns false when only username matches but homedir does not", () => {
		vi.mocked(homedir).mockReturnValue("/home/alice")
		vi.mocked(userInfo).mockReturnValue({
			username: "sandbox",
			uid: 1000,
			gid: 1000,
			shell: "/bin/bash",
			homedir: "/home/alice",
		})
		expect(isInSandboxCluster()).toBe(false)
	})

	it("returns false when neither fallback signal matches", () => {
		vi.mocked(homedir).mockReturnValue("/home/alice")
		vi.mocked(userInfo).mockReturnValue({
			username: "alice",
			uid: 1000,
			gid: 1000,
			shell: "/bin/bash",
			homedir: "/home/alice",
		})
		expect(isInSandboxCluster()).toBe(false)
	})

	it("returns false when userInfo() throws (no /etc/passwd entry)", () => {
		vi.mocked(userInfo).mockImplementation(() => {
			throw new Error("current uid has no entry in /etc/passwd")
		})
		expect(isInSandboxCluster()).toBe(false)
	})
})
