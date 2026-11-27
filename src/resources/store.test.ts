import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetOrgPolicyForTests } from "../org-policy.js"
import { setOrgPolicyForTests } from "../org-policy.test-utils.js"
import {
	getResourceOverride,
	getResourcePolicy,
	getResourcePolicySource,
	inheritedLockNote,
	isResourceEnabled,
	isResourceLocked,
	orgLockMessage,
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
		expect(isResourceEnabled("extensions.ferment-legacy", settingsPath)).toBe(false)
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.ferment-legacy"
		expect(isResourceEnabled("extensions.ferment-legacy", settingsPath)).toBe(true)
	})

	it("takes multiple comma-separated ids, whitespace-tolerant", () => {
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.memory, extensions.ferment-legacy"
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(true)
		expect(isResourceEnabled("extensions.ferment-legacy", settingsPath)).toBe(true)
	})

	it("drops malformed entries without failing the session", () => {
		process.env.KIMCHI_ENABLE_RESOURCES = ",not a resource id,,extensions.memory,"
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(true)
		expect(isResourceEnabled("extensions.ferment-legacy", settingsPath)).toBe(false)
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
		expect(getResourcePolicy("extensions.ferment-legacy")).toBeUndefined()
		expect(isResourceLocked("extensions.ferment-legacy")).toBe(false)
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
		await setOrgPolicyForTests({ resources: { "extensions.ferment-legacy": "OFF" } })

		expect(isResourceEnabled("extensions.ferment-legacy", settingsPath)).toBe(false)
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.ferment-legacy"
		expect(isResourceEnabled("extensions.ferment-legacy", settingsPath)).toBe(true)
		delete process.env.KIMCHI_ENABLE_RESOURCES
		setResourceOverride("extensions.ferment-legacy", true, settingsPath)
		expect(isResourceEnabled("extensions.ferment-legacy", settingsPath)).toBe(true)
	})

	it("entries for unknown resource ids do not affect known resources", async () => {
		await setOrgPolicyForTests({ resources: { "tools.future_thing": "FORCE_ON", "extensions.memory": "FORCE_OFF" } })

		// Unknown ids are inert in practice: nothing in the harness consults
		// them. If something did ask, the org's answer still applies.
		expect(isResourceEnabled("extensions.ferment-legacy", settingsPath)).toBe(false)
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

	it("org FORCE_OFF on extensions.ferment disables Ferment", async () => {
		expect(isResourceEnabled("extensions.ferment", settingsPath)).toBe(true)
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF" } })

		expect(isResourceEnabled("extensions.ferment", settingsPath)).toBe(false)
		expect(isResourceLocked("extensions.ferment")).toBe(true)
	})

	it("without a policy the store behaves as before", () => {
		expect(isResourceEnabled("tools.web_search", settingsPath)).toBe(true)
		expect(isResourceEnabled("extensions.memory", settingsPath)).toBe(false)
		expect(isResourceEnabled("extensions.ferment-legacy", settingsPath)).toBe(false)
	})
})

describe("inherited org FORCE_OFF (extensions.ferment-legacy from extensions.ferment)", () => {
	const LEGACY = "extensions.ferment-legacy"
	let tempDir: string
	let settingsPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-resources-inherit-"))
		settingsPath = join(tempDir, "settings.json")
		delete process.env.KIMCHI_ENABLE_RESOURCES
	})

	afterEach(() => {
		resetOrgPolicyForTests()
		rmSync(tempDir, { recursive: true, force: true })
		delete process.env.KIMCHI_ENABLE_RESOURCES
	})

	it("has no policy source without an org policy", () => {
		expect(getResourcePolicySource(LEGACY)).toBeUndefined()
		expect(getResourcePolicy(LEGACY)).toBeUndefined()
		expect(inheritedLockNote(LEGACY)).toBe("")
	})

	it("inherits FORCE_OFF and locks legacy off when legacy has no entry", async () => {
		setResourceOverride(LEGACY, true, settingsPath)
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF" } })

		expect(getResourcePolicySource(LEGACY)).toBe("extensions.ferment")
		expect(getResourcePolicy(LEGACY)).toBe("FORCE_OFF")
		expect(isResourceLocked(LEGACY)).toBe(true)
		expect(isResourceEnabled(LEGACY, settingsPath)).toBe(false)
	})

	it("refuses override writes under the inherited lock and names the source entry", async () => {
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF" } })

		const expected =
			"extensions.ferment-legacy is locked off by your organization through extensions.ferment; it cannot be enabled locally."
		expect(orgLockMessage(LEGACY)).toBe(expected)
		expect(inheritedLockNote(LEGACY)).toBe(" through extensions.ferment")
		expect(() => setResourceOverride(LEGACY, true, settingsPath)).toThrow(expected)
		expect(getResourceOverride(LEGACY, settingsPath)).toBeUndefined()
	})

	it.each(["FORCE_ON", "FORCE_OFF", "ON", "OFF"] as const)("lets legacy's own %s entry win", async (own) => {
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF", [LEGACY]: own } })

		expect(getResourcePolicySource(LEGACY)).toBe(LEGACY)
		expect(getResourcePolicy(LEGACY)).toBe(own)
		expect(inheritedLockNote(LEGACY)).toBe("")
	})

	it("keeps the plain lock message when legacy's own FORCE_OFF applies", async () => {
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF", [LEGACY]: "FORCE_OFF" } })
		expect(orgLockMessage(LEGACY)).toBe(
			"extensions.ferment-legacy is locked off by your organization; it cannot be enabled locally.",
		)
	})

	it.each(["FORCE_ON", "ON", "OFF"] as const)("does not inherit extensions.ferment %s", async (parent) => {
		await setOrgPolicyForTests({ resources: { "extensions.ferment": parent } })

		expect(getResourcePolicySource(LEGACY)).toBeUndefined()
		expect(getResourcePolicy(LEGACY)).toBeUndefined()
		expect(isResourceLocked(LEGACY)).toBe(false)
	})

	it("does not lock resources that declare no inheritance", async () => {
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF" } })

		expect(getResourcePolicySource("extensions.memory")).toBeUndefined()
		expect(isResourceLocked("extensions.memory")).toBe(false)
		// The parent itself still reports its own entry.
		expect(getResourcePolicySource("extensions.ferment")).toBe("extensions.ferment")
	})
})

describe("retired extensions.ferment-v2 id", () => {
	it("ignores a stale extensions.ferment-v2 override", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-resources-stale-"))
		const settingsPath = join(tempDir, "settings.json")
		try {
			writeFileSync(settingsPath, JSON.stringify({ resources: { "extensions.ferment-v2": false } }))
			expect(isResourceEnabled("extensions.ferment", settingsPath)).toBe(true)
		} finally {
			rmSync(tempDir, { recursive: true, force: true })
		}
	})
})
