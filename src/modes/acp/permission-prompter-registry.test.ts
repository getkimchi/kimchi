/** Registry removals with an `expected` value must be identity-checked:
 * an id key recycles across concurrent attaches, so a stale unwind must
 * never evict another session's live prompter. */

import { describe, expect, it } from "vitest"
import type { ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"
import { getAcpPrompter, registerAcpPrompter, unregisterAcpPrompter } from "./permission-prompter-registry.js"

const prompter = (tag: string) => ({ tag }) as unknown as ToolPermissionPrompter

describe("permission prompter registry", () => {
	it("identity-checked unregister skips a slot owned by a different prompter", () => {
		const loser = prompter("loser")
		const winner = prompter("winner")
		registerAcpPrompter("s1", winner)
		// Stale unwind carrying the LOSER's prompter must not evict the winner.
		expect(unregisterAcpPrompter("s1", loser)).toBe(false)
		expect(getAcpPrompter("s1")).toBe(winner)
		// … but it does evict its own prompter when the slot is still ours.
		registerAcpPrompter("s2", loser)
		expect(unregisterAcpPrompter("s2", loser)).toBe(true)
		expect(getAcpPrompter("s2")).toBeUndefined()
	})

	it("multi-owner slot: a late loser's eviction leaves the winner visible", () => {
		// failure-006 order: winner registers AND installs; a racing loser
		// registers later (displacing nothing — slot is a stack), then fails
		// and evicts only its own object.
		const winner = prompter("winner")
		const loser = prompter("loser")
		registerAcpPrompter("s4", winner)
		registerAcpPrompter("s4", loser)
		expect(getAcpPrompter("s4")).toBe(loser) // latest registration wins reads
		expect(unregisterAcpPrompter("s4", loser)).toBe(false) // slot not empty
		expect(getAcpPrompter("s4")).toBe(winner)
	})

	it("unconditional unregister keeps the legacy cleanup-path behaviour", () => {
		const p = prompter("p")
		registerAcpPrompter("s3", p)
		expect(unregisterAcpPrompter("s3")).toBe(true)
		expect(getAcpPrompter("s3")).toBeUndefined()
	})
})
