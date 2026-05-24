import { InteractiveMode } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { expect, it, vi } from "vitest"
import * as loginPatch from "./login-command-patch.js"

const { applyLoginCommandPatch, oauthDelegate } = loginPatch

function makeFakeModelRegistry() {
	return {
		authStorage: {
			set: vi.fn(),
			get: vi.fn(),
		},
		refresh: vi.fn(),
		getAvailable: vi.fn().mockReturnValue([]),
	}
}

// biome-ignore lint/suspicious/noExplicitAny: intentionally permissive fake object for testing prototype patches
type FakeIm = Record<string, any>

function makeFakeInteractiveMode(registry: ReturnType<typeof makeFakeModelRegistry>) {
	const children: unknown[] = []
	return {
		showError: vi.fn(),
		showStatus: vi.fn(),
		chatContainer: {
			addChild: vi.fn((child: unknown) => children.push(child)),
			children,
		},
		ui: {
			requestRender: vi.fn(),
		},
		session: {
			modelRegistry: registry,
			setModel: vi.fn().mockResolvedValue(undefined),
		},
	}
}

function getFeedbackMessages(fakeIm: FakeIm): string[] {
	return fakeIm.chatContainer.children
		.filter((c: unknown): c is Text => c instanceof Text)
		.map((c: Text) => (c as unknown as { text: string }).text)
}

it("intercepts showOAuthSelector('login') and runs Kimchi browser auth", async () => {
	const cliAuthModule = await import("./cli-auth/index.js")
	const authSpy = vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockResolvedValue({ token: "test-token-123" })
	const configModule = await import("./config.js")
	vi.spyOn(configModule, "writeApiKey").mockImplementation(() => {})

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockReturnValue([{ id: "kimi-k2.6", provider: "kimchi-dev" }])

	const fakeIm = makeFakeInteractiveMode(registry)
	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")

	expect(authSpy).toHaveBeenCalledOnce()
	expect(fakeIm.showStatus).toHaveBeenCalledWith("Opening browser for Kimchi login...")
	expect(registry.authStorage.set).toHaveBeenCalledWith("kimchi-dev", {
		type: "api_key",
		key: "test-token-123",
	})
	expect(registry.refresh).toHaveBeenCalledOnce()
	expect(fakeIm.session.setModel).toHaveBeenCalledWith({
		id: "kimi-k2.6",
		provider: "kimchi-dev",
	})
	expect(getFeedbackMessages(fakeIm)).toContain("✓ Logged in. Model: kimi-k2.6")
})

it("falls back to the first available model when the default is not present", async () => {
	const cliAuthModule = await import("./cli-auth/index.js")
	vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockResolvedValue({
		token: "test-token-456",
	})
	const configModule = await import("./config.js")
	vi.spyOn(configModule, "writeApiKey").mockImplementation(() => {})

	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockReturnValue([{ id: "other-model", provider: "kimchi-dev" }])

	const fakeIm = makeFakeInteractiveMode(registry)
	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")

	expect(fakeIm.session.setModel).toHaveBeenCalledWith({
		id: "other-model",
		provider: "kimchi-dev",
	})
	expect(getFeedbackMessages(fakeIm)).toContain("✓ Logged in. Model: other-model")
})

it("shows generic success when no models are available for the provider", async () => {
	const registry = makeFakeModelRegistry()
	registry.getAvailable.mockReturnValue([])

	const fakeIm = makeFakeInteractiveMode(registry)
	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")

	expect(getFeedbackMessages(fakeIm)).toContain("✓ Login successful. API key saved.")
	expect(fakeIm.session.setModel).not.toHaveBeenCalled()
})

it("shows error when browser auth fails", async () => {
	const cliAuthModule = await import("./cli-auth/index.js")
	vi.spyOn(cliAuthModule, "authenticateViaBrowser").mockRejectedValue(new Error("Browser closed"))

	const registry = makeFakeModelRegistry()
	const fakeIm = makeFakeInteractiveMode(registry)
	// biome-ignore lint/suspicious/noExplicitAny: not present in public type
	const patched = (InteractiveMode.prototype as any).showOAuthSelector
	await patched.call(fakeIm, "login")

	expect(fakeIm.showError).toHaveBeenCalledWith("Kimchi login failed: Browser closed")
	expect(registry.authStorage.set).not.toHaveBeenCalled()
})

it("passes through to original showOAuthSelector for 'logout' mode", async () => {
	// Stub oauthDelegate.original so the logout delegation path is exercised
	// without calling into the real upstream implementation (which requires a
	// fully constructed InteractiveMode with private methods).
	const stub = vi.fn().mockResolvedValue(undefined)
	const saved = oauthDelegate.original
	oauthDelegate.original = stub

	try {
		const fakeIm = makeFakeInteractiveMode(makeFakeModelRegistry())
		// biome-ignore lint/suspicious/noExplicitAny: not present in public type
		const patched = (InteractiveMode.prototype as any).showOAuthSelector
		await patched.call(fakeIm, "logout")
		expect(stub).toHaveBeenCalledOnce()
		expect(stub).toHaveBeenCalledWith("logout")
	} finally {
		oauthDelegate.original = saved
	}
})
