import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { setOrgPolicyForTests } from "../../org-policy.test-utils.js"
import { setResourceOverride } from "../../resources/store.js"
import { isInCommandReplyScope } from "../../shared/command-reply-scope.js"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { fermentNotLoadedMessage } from "./availability.js"
import { FERMENT_V2_RESOURCE_ID } from "./constants.js"
import fermentV2Extension from "./index.js"
import { fermentStubExtension, selectFermentExtension } from "./stub.js"

describe("Ferment stub", () => {
	let agentDir: string
	let consoleWarn: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "ferment-v2-stub-"))
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		resetOrgPolicyForTests()
		consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		consoleWarn.mockRestore()
		resetOrgPolicyForTests()
		Reflect.deleteProperty(process.env, "KIMCHI_CODING_AGENT_DIR")
		rmSync(agentDir, { recursive: true, force: true })
	})

	function setup() {
		const harness = createExtensionApi()
		fermentStubExtension(harness.api)
		return { harness, command: harness.getRegisteredCommand("ferment") }
	}

	it("stub tells the user how to turn Ferment on", async () => {
		setResourceOverride(FERMENT_V2_RESOURCE_ID, false)
		const { harness, command } = setup()
		expect(harness.registerCommand).toHaveBeenCalledTimes(1)
		expect(command.description).toBe("Ferment is not loaded. Run it to see how to turn it on.")
		const ctx = createCommandContext()
		await command.handler("refactor auth", ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"/ferment needs Ferment, which is off. Turn it on with: kimchi resources enable extensions.ferment\nThen restart kimchi to load it.",
			"warning",
		)
		expect(harness.sendMessage).not.toHaveBeenCalled()
		expect(harness.registerTool).not.toHaveBeenCalled()
	})

	it("sends its reply inside a command reply scope for the session, so ACP shows it", async () => {
		setResourceOverride(FERMENT_V2_RESOURCE_ID, false)
		const { command } = setup()
		const ctx = createCommandContext()
		const sessionId = ctx.sessionManager.getSessionId()
		let inScopeDuringNotify: boolean | undefined
		vi.mocked(ctx.ui.notify).mockImplementation(() => {
			inScopeDuringNotify = isInCommandReplyScope(sessionId)
		})
		expect(isInCommandReplyScope(sessionId)).toBe(false)
		await command.handler("refactor auth", ctx)
		expect(inScopeDuringNotify).toBe(true)
		expect(isInCommandReplyScope(sessionId)).toBe(false)
	})

	// Startup had Ferment off, then the user turned it on in /resources.
	it("says to restart when Ferment was turned on after a start that did not load it", async () => {
		setResourceOverride(FERMENT_V2_RESOURCE_ID, true)
		const { command } = setup()
		const ctx = createCommandContext()
		await command.handler("", ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"/ferment needs Ferment. It is on now, but it loads only when kimchi starts. Restart kimchi to use it.",
			"warning",
		)
	})

	it("names the org policy and gives no restart hint under an org FORCE_OFF", async () => {
		await setOrgPolicyForTests({ resources: { [FERMENT_V2_RESOURCE_ID]: "FORCE_OFF" } })
		const message = fermentNotLoadedMessage("/ferment")
		expect(message).toContain("your organization turned off")
		expect(message).not.toContain("restart")
		expect(message).not.toContain("kimchi resources enable")
	})

	it("prints the message to stderr when there is no UI, as in print mode", async () => {
		setResourceOverride(FERMENT_V2_RESOURCE_ID, false)
		const { command } = setup()
		const ctx = { ...createCommandContext(), hasUI: false }
		await command.handler("list", ctx)
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("/ferment needs Ferment, which is off."))
	})

	it("selector picks the stub when Ferment is off", () => {
		setResourceOverride(FERMENT_V2_RESOURCE_ID, false)
		expect(selectFermentExtension()).toBe(fermentStubExtension)
	})

	it("selector picks the real extension when Ferment is on", () => {
		expect(selectFermentExtension()).toBe(fermentV2Extension)
	})

	it("selector picks the stub under an org FORCE_OFF, even when enabled locally", async () => {
		setResourceOverride(FERMENT_V2_RESOURCE_ID, true)
		await setOrgPolicyForTests({ resources: { [FERMENT_V2_RESOURCE_ID]: "FORCE_OFF" } })
		expect(selectFermentExtension()).toBe(fermentStubExtension)
	})
})
