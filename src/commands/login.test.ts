import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("@clack/prompts", () => ({ spinner: () => ({ start: vi.fn(), stop: vi.fn() }) }))
vi.mock("../cli-auth/index.js", () => ({ authenticateViaBrowser: vi.fn() }))

import { authenticateViaBrowser } from "../cli-auth/index.js"
import * as config from "../config.js"
import { runLogin } from "./login.js"

beforeEach(() => {
	vi.clearAllMocks()
	vi.spyOn(config, "writeApiKey").mockImplementation(() => {})
	vi.mocked(authenticateViaBrowser).mockResolvedValue({ token: "new-key" })
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

it.each(["", "new-key", "old-key"])("saves login and warns only on mismatch (%s)", async (envKey) => {
	vi.stubEnv("KIMCHI_API_KEY", envKey)
	expect(await runLogin([])).toBe(0)
	expect(config.writeApiKey).toHaveBeenCalledWith("new-key")
	expect(process.env.KIMCHI_API_KEY).toBe(envKey)
	if (envKey === "old-key") {
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Using the environment key."))
		expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("unset"))
	} else {
		expect(console.warn).not.toHaveBeenCalled()
	}
})

it("does not announce a saved login when saving fails", async () => {
	vi.stubEnv("KIMCHI_API_KEY", "old-key")
	vi.mocked(config.writeApiKey).mockImplementation(() => {
		throw new Error("disk full")
	})
	expect(await runLogin([])).toBe(1)
	expect(console.warn).not.toHaveBeenCalled()
})
