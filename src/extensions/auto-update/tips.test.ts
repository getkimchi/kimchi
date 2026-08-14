import { describe, expect, it, vi } from "vitest"

const mockLoadAutoUpdateSetting = vi.fn(() => false)
const mockIsHomebrewInstall = vi.fn(() => false)

vi.mock("../../update/settings.js", () => ({ loadAutoUpdateSetting: mockLoadAutoUpdateSetting }))
vi.mock("../../update/paths.js", () => ({ isHomebrewInstall: mockIsHomebrewInstall }))

const { createAutoUpdateTipProvider } = await import("./tips.js")

describe("auto-update tip provider", () => {
	it("returns the enable-auto-update tip when auto-update is disabled", () => {
		mockLoadAutoUpdateSetting.mockReturnValue(false)
		mockIsHomebrewInstall.mockReturnValue(false)
		delete process.env.KIMCHI_NO_UPDATE_CHECK

		const tips = createAutoUpdateTipProvider().getTips()
		expect(tips).toHaveLength(1)
		expect(tips[0].id).toBe("enable-auto-update")
		expect(tips[0].scope).toBe("general")
		expect(tips[0].message).toContain("/update")
	})

	it("returns no tip when auto-update is enabled", () => {
		mockLoadAutoUpdateSetting.mockReturnValue(true)

		const tips = createAutoUpdateTipProvider().getTips()
		expect(tips).toHaveLength(0)
	})

	it("returns no tip when KIMCHI_NO_UPDATE_CHECK is set", () => {
		mockLoadAutoUpdateSetting.mockReturnValue(false)
		process.env.KIMCHI_NO_UPDATE_CHECK = "1"
		try {
			const tips = createAutoUpdateTipProvider().getTips()
			expect(tips).toHaveLength(0)
		} finally {
			delete process.env.KIMCHI_NO_UPDATE_CHECK
		}
	})

	it("returns no tip when installed via Homebrew", () => {
		mockLoadAutoUpdateSetting.mockReturnValue(false)
		mockIsHomebrewInstall.mockReturnValue(true)

		const tips = createAutoUpdateTipProvider().getTips()
		expect(tips).toHaveLength(0)
	})
})
