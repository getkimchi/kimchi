import { InteractiveMode } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { installUncaughtEpipePatch } from "./uncaught-epipe-patch.js"

describe("uncaught EPIPE patch", () => {
	it("swallows broken-pipe errors without calling the original crash handler", () => {
		const original = vi.fn()
		const modeClass = { prototype: { uncaughtCrash: original } }

		installUncaughtEpipePatch(modeClass)
		modeClass.prototype.uncaughtCrash({ code: "EPIPE" })
		modeClass.prototype.uncaughtCrash({ code: "ECONNRESET" })

		expect(original).not.toHaveBeenCalled()
	})

	it("delegates all other errors to the original crash handler", () => {
		const original = vi.fn()
		const modeClass = { prototype: { uncaughtCrash: original } }

		installUncaughtEpipePatch(modeClass)
		const error = new Error("boom")
		modeClass.prototype.uncaughtCrash(error)

		expect(original).toHaveBeenCalledWith(error)
	})

	it("wraps the crash handler once on repeated installs", () => {
		const original = vi.fn()
		const modeClass = { prototype: { uncaughtCrash: original } }

		installUncaughtEpipePatch(modeClass)
		const wrapped = modeClass.prototype.uncaughtCrash
		installUncaughtEpipePatch(modeClass)

		expect(modeClass.prototype.uncaughtCrash).toBe(wrapped)
	})

	it("targets a method that still exists on the SDK, so an upstream rename fails here instead of silently disabling the guard", () => {
		const proto = (InteractiveMode as unknown as { prototype: { uncaughtCrash?: unknown } }).prototype
		expect(typeof proto.uncaughtCrash).toBe("function")
	})
})
