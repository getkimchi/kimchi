import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetOrgPolicyForTests } from "../org-policy.js"
import { setOrgPolicyForTests } from "../org-policy.test-utils.js"
import { resourceNotLoadedMessage, resourceOffMessage } from "./not-loaded-message.js"
import { setResourceOverride } from "./store.js"

const ID = "extensions.ferment"

describe("resource off and not-loaded messages", () => {
	let agentDir: string

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "not-loaded-message-"))
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		resetOrgPolicyForTests()
	})

	afterEach(() => {
		resetOrgPolicyForTests()
		Reflect.deleteProperty(process.env, "KIMCHI_CODING_AGENT_DIR")
		rmSync(agentDir, { recursive: true, force: true })
	})

	it("tells the user how to turn the resource on and to restart when they turned it off", () => {
		setResourceOverride(ID, false)
		expect(resourceOffMessage("/ferment", ID, "Ferment")).toBe(
			"/ferment needs Ferment, which is off. Turn it on with: kimchi resources enable extensions.ferment",
		)
		expect(resourceNotLoadedMessage("/ferment", ID, "Ferment")).toBe(
			"/ferment needs Ferment, which is off. Turn it on with: kimchi resources enable extensions.ferment\nThen restart kimchi to load it.",
		)
	})

	it("uses the feature name given by the caller", () => {
		setResourceOverride(ID, false)
		expect(resourceOffMessage("/x", ID, "the legacy Ferment")).toContain("/x needs the legacy Ferment, which is off.")
	})

	it("names the policy and adds no enable command or restart line under an org FORCE_OFF", async () => {
		await setOrgPolicyForTests({ resources: { [ID]: "FORCE_OFF" } })
		const off = resourceOffMessage("/ferment", ID, "Ferment")
		expect(off).toContain("which your organization turned off")
		expect(off).toContain(ID)
		expect(off).not.toContain("kimchi resources enable")
		const notLoaded = resourceNotLoadedMessage("/ferment", ID, "Ferment")
		expect(notLoaded).toBe(off)
		expect(notLoaded).not.toContain("restart")
	})

	it("says to restart when the resource is on but did not load at startup", () => {
		expect(resourceNotLoadedMessage("/ferment", ID, "Ferment")).toBe(
			"/ferment needs Ferment. It is on now, but it loads only when kimchi starts. Restart kimchi to use it.",
		)
	})

	it("returns no off message when the resource is on", () => {
		expect(resourceOffMessage("/ferment", ID, "Ferment")).toBeUndefined()
	})
})
