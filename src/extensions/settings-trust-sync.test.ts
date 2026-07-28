import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../settings-watcher.js", () => ({
	setSettingsProjectTrusted: vi.fn(),
}))

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { setSettingsProjectTrusted } from "../settings-watcher.js"
import settingsTrustSyncExtension from "./settings-trust-sync.js"

const mockSync = vi.mocked(setSettingsProjectTrusted)

type SessionStartHandler = (event: unknown, ctx: { isProjectTrusted?: () => boolean }) => void

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
})

afterEach(() => {
	vi.restoreAllMocks()
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
