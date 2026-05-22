import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const authenticateViaBrowserMock = vi.hoisted(() => vi.fn())

vi.mock("./cli-auth/index.js", () => ({
	authenticateViaBrowser: authenticateViaBrowserMock,
}))

const { ensureAuthenticated } = await import("./startup-auth.js")

describe("ensureAuthenticated", () => {
	beforeEach(() => {
		authenticateViaBrowserMock.mockReset()
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("returns the token when browser login succeeds", async () => {
		authenticateViaBrowserMock.mockResolvedValue({ token: "castai_v1_abc123" })

		const result = await ensureAuthenticated()

		expect(result).toBe("castai_v1_abc123")
		expect(authenticateViaBrowserMock).toHaveBeenCalledTimes(1)
	})

	it("prints a missing-key message by default", async () => {
		authenticateViaBrowserMock.mockResolvedValue({ token: "tok" })

		await ensureAuthenticated()

		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No API key found"))
	})

	it("prints an expired-key message when reason is 'expired'", async () => {
		authenticateViaBrowserMock.mockResolvedValue({ token: "tok" })

		await ensureAuthenticated("expired")

		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("invalid or expired"))
	})

	it("throws and prints an error message when browser login fails", async () => {
		authenticateViaBrowserMock.mockRejectedValue(new Error("Browser refused"))

		await expect(ensureAuthenticated()).rejects.toThrow("Browser refused")

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Login failed"))
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("kimchi login"))
	})

	it("throws and prints a fallback message for non-Error rejections", async () => {
		authenticateViaBrowserMock.mockRejectedValue("network down")

		await expect(ensureAuthenticated()).rejects.toBe("network down")

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("network down"))
	})
})
