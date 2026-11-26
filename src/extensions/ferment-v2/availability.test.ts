import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { setOrgPolicyForTests } from "../../org-policy.test-utils.js"
import { setResourceOverride } from "../../resources/store.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createFermentV2AvailabilityCheck } from "./availability.js"
import { FERMENT_V2_RESOURCE_ID } from "./constants.js"

function command(name: string, source: SlashCommandInfo["source"] = "extension"): SlashCommandInfo {
	return { name, source, sourceInfo: { path: "<test>", source: "test", scope: "temporary", origin: "top-level" } }
}

// Runs against the real resource store so org policy is covered end to end.
describe("createFermentV2AvailabilityCheck", () => {
	let agentDir: string
	const savedAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
	const savedEnableResources = process.env.KIMCHI_ENABLE_RESOURCES

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "ferment-v2-availability-"))
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		resetOrgPolicyForTests()
	})

	afterEach(() => {
		resetOrgPolicyForTests()
		if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "KIMCHI_CODING_AGENT_DIR")
		else process.env.KIMCHI_CODING_AGENT_DIR = savedAgentDir
		if (savedEnableResources !== undefined) process.env.KIMCHI_ENABLE_RESOURCES = savedEnableResources
		rmSync(agentDir, { recursive: true, force: true })
	})

	function apiWithCommands(commands: SlashCommandInfo[]) {
		const harness = createExtensionApi()
		harness.getCommands.mockReturnValue(commands)
		return harness
	}

	it("is true when V2 registered /ferment and the setting is on (the default)", () => {
		const harness = apiWithCommands([command("help"), command("ferment")])
		expect(createFermentV2AvailabilityCheck(harness.api)()).toBe(true)
	})

	it("is false when /ferment was not registered, even with the setting on", () => {
		const harness = apiWithCommands([command("help")])
		expect(createFermentV2AvailabilityCheck(harness.api)()).toBe(false)
	})

	it("is false when the command list is empty", () => {
		const harness = apiWithCommands([])
		expect(createFermentV2AvailabilityCheck(harness.api)()).toBe(false)
	})

	it("ignores a prompt or skill that happens to be named ferment", () => {
		const harness = apiWithCommands([command("ferment", "prompt"), command("ferment", "skill")])
		expect(createFermentV2AvailabilityCheck(harness.api)()).toBe(false)
	})

	it("does not count /ferment-legacy as V2", () => {
		const harness = apiWithCommands([command("ferment-legacy")])
		expect(createFermentV2AvailabilityCheck(harness.api)()).toBe(false)
	})

	it("is false when the user turned extensions.ferment off", () => {
		setResourceOverride(FERMENT_V2_RESOURCE_ID, false)
		const harness = apiWithCommands([command("ferment")])
		expect(createFermentV2AvailabilityCheck(harness.api)()).toBe(false)
	})

	it("is false when the org forces extensions.ferment off, even when enabled locally", async () => {
		setResourceOverride(FERMENT_V2_RESOURCE_ID, true)
		await setOrgPolicyForTests({ resources: { [FERMENT_V2_RESOURCE_ID]: "FORCE_OFF" } })
		const harness = apiWithCommands([command("ferment")])
		expect(createFermentV2AvailabilityCheck(harness.api)()).toBe(false)
	})

	it("is true when the org forces extensions.ferment on, even when disabled locally", async () => {
		setResourceOverride(FERMENT_V2_RESOURCE_ID, false)
		await setOrgPolicyForTests({ resources: { [FERMENT_V2_RESOURCE_ID]: "FORCE_ON" } })
		const harness = apiWithCommands([command("ferment")])
		expect(createFermentV2AvailabilityCheck(harness.api)()).toBe(true)
	})

	it("reads the setting on every call, so a mid-session disable hides it at once", () => {
		const harness = apiWithCommands([command("ferment")])
		const check = createFermentV2AvailabilityCheck(harness.api)
		expect(check()).toBe(true)
		setResourceOverride(FERMENT_V2_RESOURCE_ID, false)
		expect(check()).toBe(false)
		setResourceOverride(FERMENT_V2_RESOURCE_ID, true)
		expect(check()).toBe(true)
	})

	it("reads the command list only once", () => {
		const harness = apiWithCommands([command("ferment")])
		const check = createFermentV2AvailabilityCheck(harness.api)
		check()
		check()
		expect(harness.getCommands).toHaveBeenCalledTimes(1)
	})
})
