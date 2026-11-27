import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { setResourceOverride } from "../../resources/store.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { isFermentV2LoadedAndEnabled, resetFermentV2LoadedForTests } from "./availability.js"
import { FERMENT_V2_RESOURCE_ID } from "./constants.js"
import fermentV2Extension from "./index.js"
import { isFermentPermitted, setFermentPermitted } from "./session-policy.js"
import { fermentStubExtension } from "./stub.js"

const acpHost = vi.hoisted(() => ({ value: false }))
vi.mock("../../modes/acp/state.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../modes/acp/state.js")>()),
	isAcpSessionHost: () => acpHost.value,
}))

let agentDir: string

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "ferment-session-policy-"))
	process.env.KIMCHI_CODING_AGENT_DIR = agentDir
	Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
	resetOrgPolicyForTests()
	resetFermentV2LoadedForTests()
	acpHost.value = false
	setFermentPermitted(false)
})

afterEach(() => {
	acpHost.value = false
	setFermentPermitted(false)
	resetFermentV2LoadedForTests()
	resetOrgPolicyForTests()
	Reflect.deleteProperty(process.env, "KIMCHI_CODING_AGENT_DIR")
	rmSync(agentDir, { recursive: true, force: true })
})

describe("isFermentPermitted", () => {
	it("is true outside ACP, whatever the ACP opt-in says", () => {
		expect(isFermentPermitted()).toBe(true)
		setFermentPermitted(true)
		expect(isFermentPermitted()).toBe(true)
	})

	it("is false over ACP until the client opts in", () => {
		acpHost.value = true
		expect(isFermentPermitted()).toBe(false)
	})

	it("follows the opt-in over ACP", () => {
		acpHost.value = true
		setFermentPermitted(true)
		expect(isFermentPermitted()).toBe(true)
		setFermentPermitted(false)
		expect(isFermentPermitted()).toBe(false)
	})
})

describe("Ferment over ACP", () => {
	it("does not load for a client that did not opt in: no command, no tools, not marked loaded", () => {
		acpHost.value = true
		const harness = createExtensionApi()
		fermentV2Extension(harness.api)
		expect(harness.registerCommand).not.toHaveBeenCalled()
		expect(harness.registerTool).not.toHaveBeenCalled()
		expect(isFermentV2LoadedAndEnabled()).toBe(false)
	})

	it("loads for a client that opted in", () => {
		acpHost.value = true
		setFermentPermitted(true)
		const harness = createExtensionApi()
		fermentV2Extension(harness.api)
		expect(harness.getRegisteredCommand("ferment")).toBeDefined()
		expect(harness.registerTool).toHaveBeenCalled()
		expect(isFermentV2LoadedAndEnabled()).toBe(true)
	})

	// The user chose "plain prompt": without the opt-in `/ferment` reaches the
	// model as text, the same as other opt-in commands such as /pr-watch.
	it("does not register the stub for a client that did not opt in", () => {
		acpHost.value = true
		setResourceOverride(FERMENT_V2_RESOURCE_ID, false)
		const harness = createExtensionApi()
		fermentStubExtension(harness.api)
		expect(harness.registerCommand).not.toHaveBeenCalled()
	})

	it("registers the stub for a client that opted in while Ferment is off", () => {
		acpHost.value = true
		setFermentPermitted(true)
		setResourceOverride(FERMENT_V2_RESOURCE_ID, false)
		const harness = createExtensionApi()
		fermentStubExtension(harness.api)
		expect(harness.getRegisteredCommand("ferment")).toBeDefined()
	})
})
