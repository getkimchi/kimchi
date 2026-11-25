import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "./constants.js"
import {
	getPermissionPolicySource,
	type PermissionPolicySource,
	registerPermissionPolicySource,
} from "./policy-source-registry.js"
import type { PermissionModeState } from "./types.js"

const mode: PermissionModeState = { mode: "default", initiatedBy: "user", source: "runtime" }

function source(): PermissionPolicySource {
	return {
		getMode: () => mode,
		getRules: () => [],
		getConfig: () => ({
			config: DEFAULT_CONFIG,
			allowBySource: { user: [], project: [], local: [], cli: [] },
			denyBySource: { user: [], project: [], local: [], cli: [] },
			paths: {},
		}),
		isDangerBypass: () => false,
		whenModeSettled: async () => {},
	}
}

describe("policy source registry", () => {
	it("returns the live source registered for a session", () => {
		const policy = source()
		const unregister = registerPermissionPolicySource("session-live", policy)

		expect(getPermissionPolicySource("session-live")).toBe(policy)
		unregister()
		expect(getPermissionPolicySource("session-live")).toBeUndefined()
	})

	it("does not let stale cleanup remove a replacement registration", () => {
		const first = source()
		const replacement = source()
		const unregisterFirst = registerPermissionPolicySource("session-replaced", first)
		registerPermissionPolicySource("session-replaced", replacement)

		unregisterFirst()
		expect(getPermissionPolicySource("session-replaced")).toBe(replacement)
	})
})
