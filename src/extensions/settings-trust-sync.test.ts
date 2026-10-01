import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../settings-watcher.js", () => ({
	setSettingsProjectTrusted: vi.fn(),
}))

vi.mock("../resources/definitions.js", () => ({
	invalidateResourceDefinitionsCache: vi.fn(),
}))

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isProjectScopeAllowed, resetProjectScopeTrustForTests } from "../project-scope-trust.js"
import { invalidateResourceDefinitionsCache } from "../resources/definitions.js"
import { setSettingsProjectTrusted } from "../settings-watcher.js"
import settingsTrustSyncExtension from "./settings-trust-sync.js"

const mockSync = vi.mocked(setSettingsProjectTrusted)
const mockInvalidate = vi.mocked(invalidateResourceDefinitionsCache)

interface SessionStartCtx {
	isProjectTrusted?: () => boolean
	cwd?: string
}

type SessionStartHandler = (event: unknown, ctx: SessionStartCtx) => void

/** Register the extension against a stub pi and return its session_start handler. */
function sessionStartHandler(): SessionStartHandler {
	let handler: SessionStartHandler | undefined
	const pi = {
		on: vi.fn((event: string, h: SessionStartHandler) => {
			if (event === "session_start") handler = h
		}),
	} as unknown as ExtensionAPI
	settingsTrustSyncExtension(pi)
	if (!handler) throw new Error("extension did not subscribe to session_start")
	return handler
}

beforeEach(() => {
	mockSync.mockReset()
	mockInvalidate.mockReset()
	resetProjectScopeTrustForTests()
})

afterEach(() => {
	vi.restoreAllMocks()
	resetProjectScopeTrustForTests()
})

describe("settingsTrustSyncExtension", () => {
	it("syncs a trusted decision onto the settings watcher at session start", () => {
		sessionStartHandler()({}, { isProjectTrusted: () => true })
		expect(mockSync).toHaveBeenCalledWith(true)
	})

	it("syncs an untrusted decision at session start", () => {
		sessionStartHandler()({}, { isProjectTrusted: () => false })
		expect(mockSync).toHaveBeenCalledWith(false)
	})

	it("leaves the watcher untouched when the ctx cannot report trust", () => {
		sessionStartHandler()({}, {})
		expect(mockSync).not.toHaveBeenCalled()
	})

	it("opens the kimchi project-scope gate for the session cwd when trusted", () => {
		const cwd = "/private/tmp/kimchi-trusted-project"
		sessionStartHandler()({}, { isProjectTrusted: () => true, cwd })
		expect(isProjectScopeAllowed(cwd)).toBe(true)
		expect(mockInvalidate).toHaveBeenCalledOnce()
	})

	it("closes the kimchi project-scope gate for the session cwd when untrusted", () => {
		const cwd = "/private/tmp/kimchi-untrusted-project"
		sessionStartHandler()({}, { isProjectTrusted: () => false, cwd })
		expect(isProjectScopeAllowed(cwd)).toBe(false)
		expect(mockInvalidate).toHaveBeenCalledOnce()
	})

	it("does not touch the gate for a cwd unrelated to the session", () => {
		const cwd = "/private/tmp/kimchi-trusted-project"
		sessionStartHandler()({}, { isProjectTrusted: () => true, cwd })
		expect(isProjectScopeAllowed("/private/tmp/kimchi-other-project")).toBe(false)
	})

	it("skips the gate when the ctx carries no cwd (trust-only sync)", () => {
		sessionStartHandler()({}, { isProjectTrusted: () => true })
		expect(mockInvalidate).not.toHaveBeenCalled()
	})

	it("stays silent on routine stale-ctx errors", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		sessionStartHandler()(
			{},
			{
				isProjectTrusted: () => {
					// Message prefix matched by isStaleCtxError (see stale-ctx.ts).
					throw new Error("This extension ctx is stale")
				},
			},
		)
		expect(mockSync).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})

	it("warns on unexpected trust accessor failures", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		sessionStartHandler()(
			{},
			{
				isProjectTrusted: () => {
					throw new Error("boom")
				},
			},
		)
		expect(mockSync).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalled()
	})
})
