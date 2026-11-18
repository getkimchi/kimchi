import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { isFermentV2OrchestrationActive, setFermentV2OrchestrationStatus } from "./orchestration-state.js"

const pi = {} as ExtensionAPI
afterEach(() => setFermentV2OrchestrationStatus(pi, undefined))

describe("Ferment V2 orchestration visibility", () => {
	it("registers active and paused status and releases when completed", () => {
		expect(isFermentV2OrchestrationActive(pi)).toBe(false)
		setFermentV2OrchestrationStatus(pi, "active")
		expect(isFermentV2OrchestrationActive(pi)).toBe(true)
		setFermentV2OrchestrationStatus(pi, "paused")
		expect(isFermentV2OrchestrationActive(pi)).toBe(true)
		setFermentV2OrchestrationStatus(pi, "complete")
		expect(isFermentV2OrchestrationActive(pi)).toBe(false)

		setFermentV2OrchestrationStatus(pi, "active")
		setFermentV2OrchestrationStatus(pi, undefined)
		expect(isFermentV2OrchestrationActive(pi)).toBe(false)
	})
})
