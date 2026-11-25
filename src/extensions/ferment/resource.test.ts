import { beforeEach, describe, expect, it, vi } from "vitest"

const isResourceEnabledMock = vi.hoisted(() => vi.fn<(id: string) => boolean>())
vi.mock("../../resources/store.js", () => ({ isResourceEnabled: isResourceEnabledMock }))

import { FERMENT_LEGACY_RESOURCE_ID, isFermentLegacyEnabled } from "./resource.js"

describe("isFermentLegacyEnabled", () => {
	beforeEach(() => {
		isResourceEnabledMock.mockReset()
	})

	it("uses the extensions.ferment-legacy id", () => {
		expect(FERMENT_LEGACY_RESOURCE_ID).toBe("extensions.ferment-legacy")
	})

	it("is false when the resource store reports it off (the default)", () => {
		isResourceEnabledMock.mockReturnValue(false)
		expect(isFermentLegacyEnabled()).toBe(false)
		expect(isResourceEnabledMock).toHaveBeenCalledWith("extensions.ferment-legacy")
	})

	it("is true when the resource store reports it on", () => {
		isResourceEnabledMock.mockImplementation((id) => id === "extensions.ferment-legacy")
		expect(isFermentLegacyEnabled()).toBe(true)
	})
})
