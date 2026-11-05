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
		unregisterAcpPrompter("s1", loser)
		expect(getAcpPrompter("s1")).toBe(winner)
		// … but it does evict its own prompter when the slot is still ours.
		registerAcpPrompter("s2", loser)
		unregisterAcpPrompter("s2", loser)
		expect(getAcpPrompter("s2")).toBeUndefined()
	})

	it("unconditional unregister keeps the legacy cleanup-path behaviour", () => {
		const p = prompter("p")
		registerAcpPrompter("s3", p)
		unregisterAcpPrompter("s3")
		expect(getAcpPrompter("s3")).toBeUndefined()
	})
})
