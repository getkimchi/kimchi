import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetOrgPolicyForTests } from "../org-policy.js"
import { setOrgPolicyForTests } from "../org-policy.test-utils.js"
import {
	getResourceOverride,
	getResourcePolicy,
	isResourceEnabled,
	isResourceLocked,
	resetResourceOverride,
	setResourceOverride,
} from "./store.js"

describe("KIMCHI_ENABLE_RESOURCES", () => {
	let tempDir: string
	let settingsPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-resources-"))
		settingsPath = join(tempDir, "settings.json")
		delete process.env.KIMCHI_ENABLE_RESOURCES
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		delete process.env.KIMCHI_ENABLE_RESOURCES
	})

	it("enables a default-disabled resource", () => {
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(false)
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.ferment-v2"
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(true)
	})

	it("takes multiple comma-separated ids, whitespace-tolerant", () => {
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.memory, extensions.ferment-v2"
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(true)
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(true)
	})

	it("drops malformed entries without failing the session", () => {
		process.env.KIMCHI_ENABLE_RESOURCES = ",not a resource id,,extensions.memory,"
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(true)
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(false)
	})

	it("a persistent disable wins over the env enable", () => {
		setResourceOverride("extensions.memory", false, settingsPath)
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.memory"
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(false)
	})

	it("unknown ids are inert", () => {
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.does-not-exist"
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(false)
	})
})

describe("org resource policy", () => {
	let tempDir: string
	let settingsPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-resources-policy-"))
		settingsPath = join(tempDir, "settings.json")
		delete process.env.KIMCHI_ENABLE_RESOURCES
	})

	afterEach(() => {
		resetOrgPolicyForTests()
		rmSync(tempDir, { recursive: true, force: true })
		delete process.env.KIMCHI_ENABLE_RESOURCES
	})

	it("exposes the policy entry and lock state for a resource", async () => {
		expect(getResourcePolicy("tools.web_search")).toBeUndefined()
		expect(isResourceLocked("tools.web_search")).toBe(false)

		await setOrgPolicyForTests({ resources: { "tools.web_search": "FORCE_OFF", "extensions.memory": "ON" } })

		expect(getResourcePolicy("tools.web_search")).toBe("FORCE_OFF")
		expect(isResourceLocked("tools.web_search")).toBe(true)
		expect(isResourceLocked("extensions.memory")).toBe(false)
		// Resources the map does not mention are neither policied nor locked.
		expect(getResourcePolicy("extensions.ferment-v2")).toBeUndefined()
		expect(isResourceLocked("extensions.ferment-v2")).toBe(false)
	})

	it("FORCE_OFF beats a pre-existing local override and the env enable", async () => {
		// Overrides accumulate while the resource is user-controlled; the policy
		// arrives at the next launch and must mask them.
		setResourceOverride("tools.web_search", true, settingsPath)
		process.env.KIMCHI_ENABLE_RESOURCES = "tools.web_search"
		await setOrgPolicyForTests({ resources: { "tools.web_search": "FORCE_OFF" } })

		expect(isResourceEnabled("tools.web_search", settingsPath)).toBe(false)
	})

	it("FORCE_ON beats a pre-existing disable", async () => {
		setResourceOverride("extensions.memory", false, settingsPath)
		await setOrgPolicyForTests({ resources: { "extensions.memory": "FORCE_ON" } })

		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(true)
	})

	it("ON is a soft default: a local disable still wins", async () => {
		await setOrgPolicyForTests({ resources: { "tools.web_search": "ON" } })

		expect(isResourceEnabled("tools.web_search", settingsPath)).toBe(true)
		setResourceOverride("tools.web_search", false, settingsPath)
		expect(isResourceEnabled("tools.web_search", settingsPath)).toBe(false)
	})

	it("OFF is a soft default: the env var and a local enable still win", async () => {
		await setOrgPolicyForTests({ resources: { "extensions.ferment-v2": "OFF" } })

		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(false)
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.ferment-v2"
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(true)
		delete process.env.KIMCHI_ENABLE_RESOURCES
		setResourceOverride("extensions.ferment-v2", true, settingsPath)
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(true)
	})

	it("entries for unknown resource ids do not affect known resources", async () => {
		await setOrgPolicyForTests({ resources: { "tools.future_thing": "FORCE_ON", "extensions.memory": "FORCE_OFF" } })

		// Unknown ids are inert in practice: nothing in the harness consults
		// them. If something did ask, the org's answer still applies.
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(false)
		expect(getResourcePolicy("tools.future_thing")).toBe("FORCE_ON")
		expect(isResourceEnabled("tools.future_thing", settingsPath)).toBe(true)
	})

	it("refuses override writes to locked resources and works again when the policy lifts", async () => {
		await setOrgPolicyForTests({ resources: { "tools.web_search": "FORCE_OFF" } })

		expect(() => setResourceOverride("tools.web_search", true, settingsPath)).toThrow(/locked off by your organization/)
		expect(() => resetResourceOverride("tools.web_search", settingsPath)).toThrow(/locked off by your organization/)
		// Nothing was written.
		expect(getResourceOverride("tools.web_search", settingsPath)).toBeUndefined()

		resetOrgPolicyForTests()
		setResourceOverride("tools.web_search", true, settingsPath)
		expect(getResourceOverride("tools.web_search", settingsPath)).toBe(true)
	})

	it("without a policy the store behaves as before", () => {
		expect(isResourceEnabled("tools.web_search", settingsPath)).toBe(true)
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(false)
		expect(isResourceEnabled("extensions.ferment-v2", settingsPath)).toBe(false)
	})
})
