import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { setOrgPolicyForTests } from "../../org-policy.test-utils.js"

const isResourceEnabledMock = vi.hoisted(() => vi.fn<(id: string) => boolean>())
vi.mock("../../resources/store.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../resources/store.js")>()),
	isResourceEnabled: isResourceEnabledMock,
}))

import * as store from "../../resources/store.js"
import {
	FERMENT_LEGACY_RESOURCE_ID,
	fermentLegacyOffMessage,
	isFermentLegacyEnabled,
	isFermentLegacyLoadedAndEnabled,
	markFermentLegacyLoaded,
	resetFermentLegacyLoadedForTests,
} from "./resource.js"

const realStore = await vi.importActual<typeof import("../../resources/store.js")>("../../resources/store.js")

describe("isFermentLegacyEnabled", () => {
	beforeEach(() => {
		isResourceEnabledMock.mockReset()
	})

	it("uses the extensions.ferment-legacy id", () => {
		expect(FERMENT_LEGACY_RESOURCE_ID).toBe("extensions.ferment-legacy")
	})

	it("is false when the resource store reports it off (the default)", () => {
		isResourceEnabledMock.mockReturnValue(false)
		expect(isFermentLegacyEnabled()).toBe(false)
		expect(isResourceEnabledMock).toHaveBeenCalledWith("extensions.ferment-legacy")
	})

	it("is true when the resource store reports it on", () => {
		isResourceEnabledMock.mockImplementation((id) => id === "extensions.ferment-legacy")
		expect(isFermentLegacyEnabled()).toBe(true)
	})
})

// These run against the real store, so the org-policy inheritance is covered
// end to end instead of through a mock that could agree with a wrong gate.
describe("legacy Ferment under org policy", () => {
	let agentDir: string

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "ferment-legacy-policy-"))
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		isResourceEnabledMock.mockReset()
		isResourceEnabledMock.mockImplementation((id) => realStore.isResourceEnabled(id))
		resetOrgPolicyForTests()
	})

	afterEach(() => {
		resetOrgPolicyForTests()
		Reflect.deleteProperty(process.env, "KIMCHI_CODING_AGENT_DIR")
		Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		rmSync(agentDir, { recursive: true, force: true })
	})

	function enableLegacyLocally(): void {
		store.setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
	}

	it("is off with no policy and no local choice", () => {
		expect(isFermentLegacyEnabled()).toBe(false)
	})

	it("is on with no policy when the user enabled it locally", () => {
		enableLegacyLocally()
		expect(isFermentLegacyEnabled()).toBe(true)
	})

	it("is on under a legacy FORCE_ON", async () => {
		await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_ON" } })
		expect(isFermentLegacyEnabled()).toBe(true)
	})

	it("is off under a legacy FORCE_OFF, even when enabled locally", async () => {
		enableLegacyLocally()
		await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_OFF" } })
		expect(isFermentLegacyEnabled()).toBe(false)
	})

	// Regression: the org block on the old V1 id stopped covering V1 when V1
	// moved to extensions.ferment-legacy.
	it("is off when extensions.ferment is FORCE_OFF and legacy has no policy, even when enabled locally", async () => {
		enableLegacyLocally()
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF" } })
		expect(isFermentLegacyEnabled()).toBe(false)
	})

	it("is off when extensions.ferment is FORCE_OFF and legacy is enabled through KIMCHI_ENABLE_RESOURCES", async () => {
		process.env.KIMCHI_ENABLE_RESOURCES = FERMENT_LEGACY_RESOURCE_ID
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF" } })
		expect(isFermentLegacyEnabled()).toBe(false)
	})

	it("lets a legacy FORCE_ON win over an extensions.ferment FORCE_OFF", async () => {
		await setOrgPolicyForTests({
			resources: { "extensions.ferment": "FORCE_OFF", [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_ON" },
		})
		expect(isFermentLegacyEnabled()).toBe(true)
	})

	it("lets a legacy soft ON win over an extensions.ferment FORCE_OFF", async () => {
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF", [FERMENT_LEGACY_RESOURCE_ID]: "ON" } })
		expect(isFermentLegacyEnabled()).toBe(true)
	})

	it("lets a legacy soft OFF win over an extensions.ferment FORCE_OFF, so a local enable still works", async () => {
		enableLegacyLocally()
		await setOrgPolicyForTests({
			resources: { "extensions.ferment": "FORCE_OFF", [FERMENT_LEGACY_RESOURCE_ID]: "OFF" },
		})
		expect(isFermentLegacyEnabled()).toBe(true)
	})

	it.each(["ON", "OFF", "FORCE_ON"] as const)("does not inherit extensions.ferment %s", async (policy) => {
		enableLegacyLocally()
		await setOrgPolicyForTests({ resources: { "extensions.ferment": policy } })
		expect(isFermentLegacyEnabled()).toBe(true)
	})

	it.each(["ON", "OFF", "FORCE_ON"] as const)("stays off by default under extensions.ferment %s", async (policy) => {
		await setOrgPolicyForTests({ resources: { "extensions.ferment": policy } })
		expect(isFermentLegacyEnabled()).toBe(false)
	})
})

// The setting can change after startup, but V1 loads only once. These cover
// both directions against the real store.
describe("isFermentLegacyLoadedAndEnabled", () => {
	let agentDir: string

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "ferment-legacy-loaded-"))
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		isResourceEnabledMock.mockReset()
		isResourceEnabledMock.mockImplementation((id) => realStore.isResourceEnabled(id))
		resetOrgPolicyForTests()
		resetFermentLegacyLoadedForTests()
	})

	afterEach(() => {
		resetFermentLegacyLoadedForTests()
		resetOrgPolicyForTests()
		Reflect.deleteProperty(process.env, "KIMCHI_CODING_AGENT_DIR")
		Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		rmSync(agentDir, { recursive: true, force: true })
	})

	it("is false when V1 was not loaded and legacy is off", () => {
		expect(isFermentLegacyLoadedAndEnabled()).toBe(false)
	})

	it("is false when legacy is turned on after a start that did not load V1", () => {
		store.setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
		expect(isFermentLegacyEnabled()).toBe(true)
		expect(isFermentLegacyLoadedAndEnabled()).toBe(false)
	})

	it("is true when V1 was loaded and legacy is on", () => {
		store.setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
		markFermentLegacyLoaded()
		expect(isFermentLegacyLoadedAndEnabled()).toBe(true)
	})

	it("is false when legacy is turned off after V1 was loaded", () => {
		store.setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
		markFermentLegacyLoaded()
		store.setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, false)
		expect(isFermentLegacyLoadedAndEnabled()).toBe(false)
	})

	it("is false when an org FORCE_OFF on extensions.ferment arrives after V1 was loaded", async () => {
		store.setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
		markFermentLegacyLoaded()
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF" } })
		expect(isFermentLegacyLoadedAndEnabled()).toBe(false)
	})

	it("is false under a legacy FORCE_ON when V1 was not loaded", async () => {
		await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_ON" } })
		expect(isFermentLegacyLoadedAndEnabled()).toBe(false)
	})

	it("is true under a legacy FORCE_ON when V1 was loaded", async () => {
		markFermentLegacyLoaded()
		await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_ON" } })
		expect(isFermentLegacyLoadedAndEnabled()).toBe(true)
	})

	it("resets to not loaded", () => {
		store.setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
		markFermentLegacyLoaded()
		resetFermentLegacyLoadedForTests()
		expect(isFermentLegacyLoadedAndEnabled()).toBe(false)
	})
})

describe("fermentLegacyOffMessage", () => {
	let agentDir: string

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "ferment-legacy-message-"))
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		isResourceEnabledMock.mockReset()
		isResourceEnabledMock.mockImplementation((id) => realStore.isResourceEnabled(id))
		resetOrgPolicyForTests()
	})

	afterEach(() => {
		resetOrgPolicyForTests()
		Reflect.deleteProperty(process.env, "KIMCHI_CODING_AGENT_DIR")
		Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		rmSync(agentDir, { recursive: true, force: true })
	})

	it("is undefined when legacy is on", () => {
		process.env.KIMCHI_ENABLE_RESOURCES = FERMENT_LEGACY_RESOURCE_ID
		expect(fermentLegacyOffMessage("/ferment-legacy")).toBeUndefined()
	})

	it("suggests kimchi resources enable when legacy is off locally", () => {
		expect(fermentLegacyOffMessage("/ferment-legacy")).toBe(
			"/ferment-legacy needs the legacy Ferment, which is off. Turn it on with: kimchi resources enable extensions.ferment-legacy",
		)
	})

	it("names the legacy entry under a legacy FORCE_OFF", async () => {
		await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_OFF" } })
		expect(fermentLegacyOffMessage("/ferment-legacy")).toBe(
			"/ferment-legacy needs the legacy Ferment, which your organization turned off (extensions.ferment-legacy is locked off). Ask your organization admin to change the policy.",
		)
	})

	it("names extensions.ferment when the block is inherited from it", async () => {
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF" } })
		const message = fermentLegacyOffMessage("/ferment-legacy")
		expect(message).toBe(
			"/ferment-legacy needs the legacy Ferment, which your organization turned off (extensions.ferment is locked off). Ask your organization admin to change the policy.",
		)
		expect(message).not.toContain("resources enable")
	})

	it("keeps the enable hint under a legacy soft OFF, even when extensions.ferment is FORCE_OFF", async () => {
		await setOrgPolicyForTests({
			resources: { "extensions.ferment": "FORCE_OFF", [FERMENT_LEGACY_RESOURCE_ID]: "OFF" },
		})
		expect(fermentLegacyOffMessage("--init-git")).toBe(
			"--init-git needs the legacy Ferment, which is off. Turn it on with: kimchi resources enable extensions.ferment-legacy",
		)
	})
})
