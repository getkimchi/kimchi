import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { STALE_CTX_MESSAGE_PREFIX } from "../stale-ctx.js"
import { createExtensionApi } from "./extension-api.js"

/**
 * Invalidation semantics of the shared pi mock. Pi's runner invalidates the
 * per-call extension runtime together with its ctx on session
 * replace/fork/reload; every asserting API method then throws via
 * assertActive. The mock must reproduce that, or stale-ctx regression tests
 * are silently masked by an always-permissive API surface.
 */
describe("createExtensionApi invalidation semantics", () => {
	it("records appended entries and delivers events while fresh", () => {
		const mock = createExtensionApi()
		const seen: unknown[] = []
		mock.api.events.on("test:channel", (data) => seen.push(data))

		mock.api.appendEntry("test:entry", { a: 1 })
		mock.api.events.emit("test:channel", "hello")

		expect(mock.getAppendedEntries("test:entry")).toEqual([{ a: 1 }])
		expect(seen).toEqual(["hello"])
		// The raw bus emit stays observable for delivery assertions.
		expect(mock.emitEvent).toHaveBeenCalledWith("test:channel", "hello")
	})

	it("throws the shared stale-ctx message from every asserting API after invalidate()", () => {
		const mock = createExtensionApi()
		mock.invalidate()

		expect(() => mock.api.appendEntry("test:entry", {})).toThrowError(STALE_CTX_MESSAGE_PREFIX)
		expect(() => mock.api.events.emit("test:channel", {})).toThrowError(STALE_CTX_MESSAGE_PREFIX)
		expect(() =>
			mock.api.sendMessage({
				customType: "test:message",
				content: "x",
				display: true,
			} as Parameters<ExtensionAPI["sendMessage"]>[0]),
		).toThrowError(STALE_CTX_MESSAGE_PREFIX)
		// Nothing was recorded through the throwing paths.
		expect(mock.getAppendedEntries("test:entry")).toEqual([])
		expect(mock.emitEvent).not.toHaveBeenCalled()
	})
})
