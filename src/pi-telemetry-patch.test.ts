import { InteractiveMode } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
// Direct dist import: mergeProviderAttributionHeaders is not re-exported from
// the package root (exports map). Same pattern as model-selector-table.test.ts.
import { mergeProviderAttributionHeaders } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-attribution.js"
import { applyPiTelemetryPatch } from "./pi-telemetry-patch.js"

// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype mutation
const imProto = InteractiveMode.prototype as any

// Capture pi's real (unpatched) ping method at module load, before any test
// applies the patch, so the before/after controls exercise pi's actual code.
const originalReportInstallTelemetry: (version: string) => void = imProto.reportInstallTelemetry

describe("applyPiTelemetryPatch", () => {
	const savedTelemetry = process.env.PI_TELEMETRY
	const savedOffline = process.env.PI_OFFLINE

	afterEach(() => {
		vi.restoreAllMocks()
		// Restore the prototype so the suite stays order-independent: the patch
		// is a direct assignment that vi.restoreAllMocks() does not undo.
		imProto.reportInstallTelemetry = originalReportInstallTelemetry
		if (savedTelemetry === undefined) delete process.env.PI_TELEMETRY
		else process.env.PI_TELEMETRY = savedTelemetry
		if (savedOffline === undefined) delete process.env.PI_OFFLINE
		else process.env.PI_OFFLINE = savedOffline
	})

	it("forces PI_TELEMETRY=0 regardless of any pre-set value and is idempotent", () => {
		process.env.PI_TELEMETRY = "1"
		applyPiTelemetryPatch()
		applyPiTelemetryPatch()
		expect(process.env.PI_TELEMETRY).toBe("0")
	})

	it("pi's real ping fires when the gate is open, and dies via env and via patch", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))
		delete process.env.PI_OFFLINE
		delete process.env.PI_TELEMETRY
		// biome-ignore lint/suspicious/noExplicitAny: minimal stub of the private `this` the method reads
		const fakeThis = { settingsManager: { getEnableInstallTelemetry: () => true } } as any

		// Before: with no kill switch, pi's unpatched method consults its gate
		// and fires the pi.dev ping.
		await originalReportInstallTelemetry.call(fakeThis, "9.9.9")
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(String(fetchSpy.mock.calls[0][0])).toContain("pi.dev/api/report-install")

		// Env kill switch alone stops pi's unpatched method (shared gate with
		// the OpenRouter/NVIDIA/Cloudflare attribution headers).
		process.env.PI_TELEMETRY = "0"
		fetchSpy.mockClear()
		await originalReportInstallTelemetry.call(fakeThis, "9.9.9")
		expect(fetchSpy).not.toHaveBeenCalled()

		// The prototype no-op stops it even with the gate forced open.
		applyPiTelemetryPatch()
		delete process.env.PI_TELEMETRY
		process.env.PI_TELEMETRY = "1"
		imProto.reportInstallTelemetry.call(fakeThis, "9.9.9")
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("attribution headers carry pi.dev branding when the gate is open and vanish with the kill switch", () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal stub of the SettingsManager surface the gate reads
		const settingsManager = { getEnableInstallTelemetry: () => true } as any
		// biome-ignore lint/suspicious/noExplicitAny: provider shape matches isOpenRouterModel's duck typing
		const openRouterModel = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } as any

		// Before: with no kill switch, requests routed through OpenRouter are
		// stamped with pi's attribution headers.
		delete process.env.PI_TELEMETRY
		const open = mergeProviderAttributionHeaders(openRouterModel, settingsManager, undefined)
		expect(open?.["HTTP-Referer"]).toBe("https://pi.dev")
		expect(open?.["X-OpenRouter-Title"]).toBe("pi")

		// After: the kill switch removes them entirely.
		process.env.PI_TELEMETRY = "0"
		expect(mergeProviderAttributionHeaders(openRouterModel, settingsManager, undefined)).toBeUndefined()
	})
})
