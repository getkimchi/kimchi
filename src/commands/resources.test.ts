/**
 * Tests for the `kimchi resources` CLI subcommand's org-policy behavior:
 * org-locked resources refuse enable/disable/set/reset with a nonzero exit
 * code and a clear message, and the list marks locked entries. The lock
 * itself (precedence, write guard) is covered in src/resources/store.test.ts.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetOrgPolicyForTests } from "../org-policy.js"
import { setOrgPolicyForTests } from "../org-policy.test-utils.js"
import { getResourceOverride } from "../resources/store.js"
import { runResources } from "./resources.js"

describe("runResources org-policy refusals", () => {
	let tempDir: string
	let log: ReturnType<typeof vi.spyOn>
	let error: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-resources-cli-"))
		process.env.KIMCHI_CODING_AGENT_DIR = tempDir
		log = vi.spyOn(console, "log").mockImplementation(() => {})
		error = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		resetOrgPolicyForTests()
		if (process.env.KIMCHI_CODING_AGENT_DIR === tempDir) delete process.env.KIMCHI_CODING_AGENT_DIR
		rmSync(tempDir, { recursive: true, force: true })
		log.mockRestore()
		error.mockRestore()
	})

	it("enable on a FORCE_OFF resource is refused with exit 1 and nothing is written", async () => {
		await setOrgPolicyForTests({ resources: { "tools.web_search": "FORCE_OFF" } })

		await expect(runResources(["enable", "tools.web_search"])).resolves.toBe(1)

		expect(error).toHaveBeenCalledWith(
			"tools.web_search is locked off by your organization; it cannot be enabled locally.",
		)
		expect(getResourceOverride("tools.web_search", join(tempDir, "settings.json"))).toBeUndefined()
	})

	it("disable on a FORCE_ON resource is refused with exit 1", async () => {
		await setOrgPolicyForTests({ resources: { "tools.web_search": "FORCE_ON" } })

		await expect(runResources(["disable", "tools.web_search"])).resolves.toBe(1)
		await expect(runResources(["set", "tools.web_search", "off"])).resolves.toBe(1)
		await expect(runResources(["reset", "tools.web_search"])).resolves.toBe(1)

		expect(log).not.toHaveBeenCalledWith(expect.stringContaining("tools.web_search:"))
	})

	it("enable on an unlocked resource still works", async () => {
		await setOrgPolicyForTests({ resources: { "tools.web_search": "FORCE_OFF" } })

		await expect(runResources(["enable", "extensions.ferment-v2"])).resolves.toBe(0)

		expect(log).toHaveBeenCalledWith("extensions.ferment-v2: enabled")
	})

	it("the list marks org-locked entries", async () => {
		await setOrgPolicyForTests({ resources: { "tools.web_search": "FORCE_OFF" } })

		await expect(runResources(["list"])).resolves.toBe(0)

		expect(log).toHaveBeenCalledWith(expect.stringContaining("tools.web_search [org-locked]"))
	})
})
