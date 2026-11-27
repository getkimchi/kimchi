import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

const isFermentLegacyEnabledMock = vi.hoisted(() => vi.fn<() => boolean>())
const fermentLegacyNotLoadedMessageMock = vi.hoisted(() => vi.fn<(subject: string) => string>())
const markFermentLegacyLoadedSpy = vi.hoisted(() => vi.fn<() => void>())
vi.mock("./resource.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./resource.js")>()),
	isFermentLegacyEnabled: isFermentLegacyEnabledMock,
	fermentLegacyNotLoadedMessage: fermentLegacyNotLoadedMessageMock,
	markFermentLegacyLoaded: markFermentLegacyLoadedSpy,
}))

const acpHost = vi.hoisted(() => ({ value: false }))
vi.mock("../../modes/acp/state.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../modes/acp/state.js")>()),
	isAcpSessionHost: () => acpHost.value,
}))

import fermentExtension from "./index.js"
import { fermentLegacyStubExtension, selectFermentLegacyExtension } from "./legacy-stub.js"

describe("selectFermentLegacyExtension", () => {
	beforeEach(() => {
		isFermentLegacyEnabledMock.mockReset()
	})

	it("picks V1 when legacy is on at startup, so the stub does not take its name", () => {
		isFermentLegacyEnabledMock.mockReturnValue(true)
		expect(selectFermentLegacyExtension()).toBe(fermentExtension)
	})

	// Regression: with legacy off nothing owned /ferment-legacy, so the text
	// went to the model as a prompt.
	it("picks the stub when legacy is off at startup", () => {
		isFermentLegacyEnabledMock.mockReturnValue(false)
		expect(selectFermentLegacyExtension()).toBe(fermentLegacyStubExtension)
	})
})

describe("fermentLegacyStubExtension", () => {
	let consoleWarn: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		fermentLegacyNotLoadedMessageMock.mockReset()
		fermentLegacyNotLoadedMessageMock.mockImplementation((subject) => `${subject} is not loaded.`)
		consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		consoleWarn.mockRestore()
	})

	function setup() {
		const harness = createExtensionApi()
		fermentLegacyStubExtension(harness.api)
		return { harness, command: harness.getRegisteredCommand("ferment-legacy") }
	}

	it("registers only the /ferment-legacy command", () => {
		const { harness, command } = setup()
		expect(harness.registerCommand).toHaveBeenCalledTimes(1)
		expect(command.description).toBe("Legacy Ferment (V1) is not loaded. Run it to see how to turn it on.")
		expect(harness.registerTool).not.toHaveBeenCalled()
	})

	it("shows the not-loaded message as a warning and sends nothing to the model", async () => {
		const { harness, command } = setup()
		const ctx = createCommandContext()
		await command.handler("", ctx)
		expect(fermentLegacyNotLoadedMessageMock).toHaveBeenCalledWith("/ferment-legacy")
		expect(ctx.ui.notify).toHaveBeenCalledWith("/ferment-legacy is not loaded.", "warning")
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it.each([
		"list",
		'new "Name"',
		"switch abc",
		"  exit  ",
	])("ignores the arguments in /ferment-legacy %s", async (args) => {
		const { harness, command } = setup()
		const ctx = createCommandContext()
		await command.handler(args, ctx)
		expect(fermentLegacyNotLoadedMessageMock).toHaveBeenCalledWith("/ferment-legacy")
		expect(ctx.ui.notify).toHaveBeenCalledWith("/ferment-legacy is not loaded.", "warning")
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("prints the message to stderr when there is no UI, as in print mode", async () => {
		const { command } = setup()
		const ctx = { ...createCommandContext(), hasUI: false }
		await command.handler("list", ctx)
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		expect(consoleWarn).toHaveBeenCalledWith("/ferment-legacy is not loaded.")
	})
})

// Legacy Ferment is not supported over ACP: neither V1 nor its stub loads there.
describe("legacy Ferment over ACP", () => {
	beforeEach(() => {
		acpHost.value = true
	})

	afterEach(() => {
		acpHost.value = false
	})

	it("the stub registers nothing, so ACP has no /ferment-legacy", () => {
		const harness = createExtensionApi()
		fermentLegacyStubExtension(harness.api)
		expect(harness.registerCommand).not.toHaveBeenCalled()
	})

	it("V1 registers nothing and is not marked loaded, even when legacy is on", () => {
		isFermentLegacyEnabledMock.mockReturnValue(true)
		const harness = createExtensionApi()
		fermentExtension(harness.api)
		expect(harness.registerCommand).not.toHaveBeenCalled()
		expect(harness.registerTool).not.toHaveBeenCalled()
		expect(markFermentLegacyLoadedSpy).not.toHaveBeenCalled()
	})
})
