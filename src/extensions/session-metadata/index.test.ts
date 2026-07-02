import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as sessionMetadataStore from "../../utils/session-metadata-store.js"
import { _resetSessionMetadataStore } from "../../utils/session-metadata-store.js"
import * as settingsChangeEmitter from "../telemetry/settings-change-emitter.js"
import sessionMetadataExtension from "./index.js"

/**
 * Minimal `pi` stub that captures handlers registered via `pi.on(event, cb)`
 * so the test can drive `session_shutdown` manually. The real ExtensionAPI is
 * far richer; we only need `on` for this extension.
 */
type CapturedHandler = (event?: unknown, ctx?: unknown) => unknown

function makePi(): ExtensionAPI & {
	_handlers: Map<string, CapturedHandler[]>
	fireShutdown: () => void
} {
	const handlers = new Map<string, CapturedHandler[]>()
	const pi = {
		on: (event: string, handler: CapturedHandler) => {
			const existing = handlers.get(event) ?? []
			existing.push(handler)
			handlers.set(event, existing)
		},
	}
	const stub = {
		...pi,
		_handlers: handlers,
		fireShutdown: () => {
			for (const handler of handlers.get("session_shutdown") ?? []) handler({})
		},
	}
	return stub as unknown as ExtensionAPI & {
		_handlers: Map<string, CapturedHandler[]>
		fireShutdown: () => void
	}
}

describe("sessionMetadataExtension", () => {
	// biome-ignore lint/suspicious/noExplicitAny: mock spy refs typed loosely to avoid vitest MockInstance generic friction
	let watcherSpy: any
	// biome-ignore lint/suspicious/noExplicitAny: mock spy refs typed loosely to avoid vitest MockInstance generic friction
	let recordSpy: any
	// Captured emit callback handed to startSettingsChangeWatcher by the
	// extension under test. Invoking it simulates the watcher firing.
	let emit: (event: string, properties: Record<string, string | number | boolean>) => void
	// The stop fn returned by the mocked watcher.
	let stopWatcher: () => void

	beforeEach(() => {
		_resetSessionMetadataStore()

		emit = () => {}
		stopWatcher = vi.fn()
		watcherSpy = vi.spyOn(settingsChangeEmitter, "startSettingsChangeWatcher").mockImplementation((cb: unknown) => {
			emit = cb as (event: string, properties: Record<string, string | number | boolean>) => void
			return stopWatcher
		})
		recordSpy = vi.spyOn(sessionMetadataStore, "recordConfigChange").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		_resetSessionMetadataStore()
	})

	it("exports a default factory function", () => {
		expect(typeof sessionMetadataExtension).toBe("function")
	})

	it("starts the settings-change watcher on init", () => {
		const pi = makePi()
		sessionMetadataExtension()(pi)

		expect(watcherSpy).toHaveBeenCalledTimes(1)
	})

	it("records config_changed events via recordConfigChange with the exact key/value", () => {
		const pi = makePi()
		sessionMetadataExtension()(pi)

		emit("config_changed", { key: "theme", value: "dark" })

		expect(recordSpy).toHaveBeenCalledWith("theme", "dark")
	})

	it("passes already-redacted string values through unchanged", () => {
		const pi = makePi()
		sessionMetadataExtension()(pi)

		emit("config_changed", { key: "endpoint", value: "redacted:url" })

		expect(recordSpy).toHaveBeenCalledWith("endpoint", "redacted:url")
	})

	it("passes numeric values through", () => {
		const pi = makePi()
		sessionMetadataExtension()(pi)

		emit("config_changed", { key: "count", value: 5 })

		expect(recordSpy).toHaveBeenCalledWith("count", 5)
	})

	it("passes boolean values through", () => {
		const pi = makePi()
		sessionMetadataExtension()(pi)

		emit("config_changed", { key: "flag", value: true })

		expect(recordSpy).toHaveBeenCalledWith("flag", true)
	})

	it("ignores non-config_changed events", () => {
		const pi = makePi()
		sessionMetadataExtension()(pi)

		emit("session_started", { key: "theme", value: "dark" })
		emit("some_other_event", { key: "flag", value: true })

		expect(recordSpy).not.toHaveBeenCalled()
	})

	it("stops the watcher on session_shutdown", () => {
		const pi = makePi()
		sessionMetadataExtension()(pi)

		pi.fireShutdown()

		expect(stopWatcher).toHaveBeenCalledTimes(1)
	})

	it("session_shutdown is idempotent — stop is only called once", () => {
		const pi = makePi()
		sessionMetadataExtension()(pi)

		pi.fireShutdown()
		pi.fireShutdown()

		expect(stopWatcher).toHaveBeenCalledTimes(1)
	})

	it("does not crash when recordConfigChange throws", () => {
		const pi = makePi()
		sessionMetadataExtension()(pi)

		recordSpy.mockImplementation(() => {
			throw new Error("boom")
		})

		// The emit callback must swallow the error rather than propagate it.
		expect(() => emit("config_changed", { key: "theme", value: "dark" })).not.toThrow()

		// recordConfigChange was still attempted.
		expect(recordSpy).toHaveBeenCalledWith("theme", "dark")
	})
})
