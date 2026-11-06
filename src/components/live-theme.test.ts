import { afterEach, describe, expect, it } from "vitest"
import { testTheme } from "../extensions/__mocks__/theme.js"
import { liveTheme } from "./live-theme.js"

const PI_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme")
const globals = globalThis as Record<symbol, unknown>
const original = globals[PI_THEME_KEY]

afterEach(() => {
	globals[PI_THEME_KEY] = original
})

describe("liveTheme", () => {
	it("returns the theme instance pi keeps on globalThis", () => {
		globals[PI_THEME_KEY] = testTheme

		expect(liveTheme()).toBe(testTheme)
	})

	it("returns undefined before pi initialises a theme", () => {
		globals[PI_THEME_KEY] = undefined

		expect(liveTheme()).toBeUndefined()
	})

	it("returns undefined for a value that is not a theme", () => {
		globals[PI_THEME_KEY] = { fg: "not a function" }

		expect(liveTheme()).toBeUndefined()
	})
})
