import type { Component } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it } from "vitest"
import { frameBox, frameOf } from "../__mocks__/side-chat-host.js"
import {
	addCompositor,
	addMouseInterceptor,
	addWheelInterceptor,
	applyCompositors,
	installSideChatHarnessPatch,
	interceptMouse,
	interceptWheel,
	isLeftPress,
	isMouseMotion,
	missingHarnessMembers,
	type RawMouseEvent,
	rectContains,
	rectOf,
} from "./harness.js"

const component = (): Component => ({ render: () => [], invalidate: () => {} })
const press = (button: number, release = false): RawMouseEvent => ({ button, x: 0, y: 0, release })

const removers: Array<() => void> = []
afterEach(() => {
	for (const remove of removers.splice(0)) remove()
})

describe("upstream compatibility", () => {
	// Canary for pi upgrades: a missing member disables the side chat at runtime.
	it("finds every private member it patches in the pinned upstream", () => {
		expect(missingHarnessMembers()).toEqual([])
		expect(installSideChatHarnessPatch()).toBe(true)
	})

	it("installs once", () => {
		expect(installSideChatHarnessPatch()).toBe(true)
		expect(installSideChatHarnessPatch()).toBe(true)
	})
})

describe("mouse decoding", () => {
	it.each([
		{ name: "left press", event: press(0), left: true, motion: false },
		{ name: "left release", event: press(0, true), left: false, motion: false },
		{ name: "right press", event: press(2), left: false, motion: false },
		{ name: "left drag", event: press(32), left: false, motion: true },
		{ name: "wheel up", event: press(64), left: false, motion: false },
	])("$name", ({ event, left, motion }) => {
		expect(isLeftPress(event)).toBe(left)
		expect(isMouseMotion(event)).toBe(motion)
	})
})

describe("frame geometry", () => {
	it("finds a nested component's rect", () => {
		const target = component()
		const rect = { x: 3, y: 2, width: 4, height: 5 }
		const frame = frameOf(20, 10, [
			frameBox(component(), { x: 0, y: 0, width: 10, height: 10 }, [frameBox(target, rect)]),
		])

		expect(rectOf(frame, target)).toEqual(rect)
		expect(rectOf(frame, component())).toBeUndefined()
		expect(rectOf(undefined, target)).toBeUndefined()
	})

	it("treats the rect as half-open", () => {
		const rect = { x: 3, y: 2, width: 4, height: 5 }

		expect(rectContains(rect, 3, 2)).toBe(true)
		expect(rectContains(rect, 6, 6)).toBe(true)
		expect(rectContains(rect, 7, 2)).toBe(false)
		expect(rectContains(rect, 3, 7)).toBe(false)
	})
})

describe("hooks", () => {
	it("chains compositors in registration order and stops after removal", () => {
		const frame = frameOf(10, 1, [])
		removers.push(addCompositor((screen) => screen.map((line) => `${line}a`)))
		const removeB = addCompositor((screen) => screen.map((line) => `${line}b`))

		expect(applyCompositors(["x"], frame, 10)).toEqual(["xab"])
		removeB()
		expect(applyCompositors(["x"], frame, 10)).toEqual(["xa"])
	})

	it("stops at the first interceptor that consumes an event", () => {
		const seen: string[] = []
		removers.push(
			addMouseInterceptor(() => {
				seen.push("first")
				return true
			}),
			addMouseInterceptor(() => {
				seen.push("second")
				return true
			}),
			addWheelInterceptor((_x, _y, delta) => delta > 0),
		)

		expect(interceptMouse(press(0))).toBe(true)
		expect(seen).toEqual(["first"])
		expect(interceptWheel(0, 0, 1)).toBe(true)
		expect(interceptWheel(0, 0, -1)).toBe(false)
	})

	it("passes events through when nothing is registered", () => {
		expect(interceptMouse(press(0))).toBe(false)
		expect(interceptWheel(0, 0, 1)).toBe(false)
		expect(applyCompositors(["x"], frameOf(1, 1, []), 1)).toEqual(["x"])
	})
})
