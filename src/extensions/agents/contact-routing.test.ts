import { describe, expect, it } from "vitest"
import { resolveUserContact, USER_CONTACT_ROUTES } from "./contact-routing.js"

describe("resolveUserContact", () => {
	it("prefers the judge over the questionnaire in autonomous sessions even with a UI attached", () => {
		expect(resolveUserContact({ hasUI: true, judgeRoute: { fermentId: "f-1" } })).toEqual({
			reachable: true,
			route: "ferment_judge",
			ferment_id: "f-1",
		})
	})

	it("falls back to the questionnaire when no judge is available and a UI is attached", () => {
		expect(resolveUserContact({ hasUI: true })).toEqual({ reachable: true, route: "questionnaire" })
	})

	it("ends at the unavailable terminal route when no audience matches", () => {
		const contact = resolveUserContact({ hasUI: false })
		expect(contact).toMatchObject({ reachable: false, route: "unavailable" })
	})

	it("declares judge before questionnaire before the terminal unavailable route", () => {
		const env = { hasUI: true, judgeRoute: { fermentId: "f-1" } }
		expect(USER_CONTACT_ROUTES.map((route) => route(env)?.route)).toEqual([
			"ferment_judge",
			"questionnaire",
			"unavailable",
		])
	})
})
