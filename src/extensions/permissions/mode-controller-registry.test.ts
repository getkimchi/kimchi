/** Registry removals with an `expected` value must be identity-checked:
 * an id key recycles across concurrent attaches, respawns, and failed
 * loads (a corrupted duplicate file), so a stale unwind must never evict
 * a live session's controller — and the boolean keeps env cleanup paired. */

import { describe, expect, it } from "vitest"
import {
	getSessionPermissionFlagController,
	registerSessionPermissionFlagController,
	unregisterSessionPermissionFlagController,
} from "./mode-controller-registry.js"
import type { SessionPermissionFlagController } from "./types.js"

const controller = (tag: string) => ({ tag }) as unknown as SessionPermissionFlagController

describe("permission mode controller registry", () => {
	it("identity-checked unregister skips a slot owned by a different controller", () => {
		const loser = controller("loser")
		const winner = controller("winner")
		registerSessionPermissionFlagController("s1", winner)
		// Stale unwind carrying another controller must not evict the winner.
		expect(unregisterSessionPermissionFlagController("s1", loser)).toBe(false)
		expect(getSessionPermissionFlagController("s1")).toBe(winner)
		// … but it does evict its own controller when the slot is still ours.
		registerSessionPermissionFlagController("s2", loser)
		expect(unregisterSessionPermissionFlagController("s2", loser)).toBe(true)
		expect(getSessionPermissionFlagController("s2")).toBeUndefined()
	})

	it("unconditional unregister keeps the legacy cleanup-path behaviour", () => {
		const c = controller("c")
		registerSessionPermissionFlagController("s3", c)
		expect(unregisterSessionPermissionFlagController("s3")).toBe(true)
		expect(getSessionPermissionFlagController("s3")).toBeUndefined()
	})
})
