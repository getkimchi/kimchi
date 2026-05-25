import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const isHomebrewInstallMock = vi.fn(() => false)
const checkForUpdateMock = vi.fn()
const applyUpdateMock = vi.fn()
const getVersionMock = vi.fn(() => "v0.0.23")
const ensureSuperpowersInstalledMock = vi.fn()

vi.mock("../update/paths.js", () => ({
	isHomebrewInstall: () => isHomebrewInstallMock(),
}))
vi.mock("../update/workflow.js", () => ({
	checkForUpdate: (...args: unknown[]) => checkForUpdateMock(...args),
	applyUpdate: (...args: unknown[]) => applyUpdateMock(...args),
}))
vi.mock("../utils.js", () => ({
	getVersion: () => getVersionMock(),
}))
vi.mock("../extensions/superpowers/installer.js", () => ({
	ensureSuperpowersInstalled: (...args: unknown[]) => ensureSuperpowersInstalledMock(...args),
}))

const { runUpdate } = await import("./update.js")

describe("runUpdate flag parsing", () => {
	let logSpy: ReturnType<typeof vi.spyOn>
	let errSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		isHomebrewInstallMock.mockReset()
		isHomebrewInstallMock.mockReturnValue(false)
		checkForUpdateMock.mockReset()
		applyUpdateMock.mockReset()
	})

	afterEach(() => {
		logSpy.mockRestore()
		errSpy.mockRestore()
	})

	it("--help documents --canary", async () => {
		const code = await runUpdate(["--help"])
		expect(code).toBe(0)
		const out = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(out).toContain("--canary")
		expect(out).toContain("Usage: kimchi update")
	})

	it("rejects unknown flags", async () => {
		const code = await runUpdate(["--bogus"])
		expect(code).toBe(2)
		expect(errSpy).toHaveBeenCalled()
	})
})

describe("runUpdate Homebrew branch", () => {
	let logSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		isHomebrewInstallMock.mockReset()
		checkForUpdateMock.mockReset()
		applyUpdateMock.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("prints canary-specific message on Homebrew + --canary and skips download", async () => {
		isHomebrewInstallMock.mockReturnValue(true)
		const code = await runUpdate(["--canary"])
		expect(code).toBe(0)
		const out = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(out).toContain("Canary builds are not published to Homebrew")
		expect(out).toContain("brew uninstall kimchi")
		expect(out).toContain("install.sh")
		expect(out).toContain("kimchi update --canary")
		expect(out).not.toContain("brew upgrade kimchi")
		expect(checkForUpdateMock).not.toHaveBeenCalled()
		expect(applyUpdateMock).not.toHaveBeenCalled()
	})

	it("prints generic Homebrew message on bare update (no --canary)", async () => {
		isHomebrewInstallMock.mockReturnValue(true)
		const code = await runUpdate([])
		expect(code).toBe(0)
		const out = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(out).toContain("brew upgrade kimchi")
		expect(out).not.toContain("brew uninstall kimchi")
		expect(checkForUpdateMock).not.toHaveBeenCalled()
	})
})

describe("runUpdate non-interactive composition", () => {
	let logSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		isHomebrewInstallMock.mockReset()
		isHomebrewInstallMock.mockReturnValue(false)
		checkForUpdateMock.mockReset()
		applyUpdateMock.mockReset()
		ensureSuperpowersInstalledMock.mockReset()
		ensureSuperpowersInstalledMock.mockResolvedValue(true)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("--canary --dry-run reports the canary version without installing", async () => {
		checkForUpdateMock.mockResolvedValue({
			hasUpdate: true,
			latestVersion: "0.0.0-canary.20260509.abc1234",
			tag: "canary",
			releaseUrl: "https://example/releases/tag/canary",
		})
		const code = await runUpdate(["--canary", "--dry-run"])
		expect(code).toBe(0)
		expect(applyUpdateMock).not.toHaveBeenCalled()
		expect(checkForUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ canary: true, skipCache: true }))
		const out = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(out).toContain("0.0.0-canary.20260509.abc1234")
	})

	it("--canary --force installs without prompting", async () => {
		checkForUpdateMock.mockResolvedValue({
			hasUpdate: true,
			latestVersion: "0.0.0-canary.20260509.abc1234",
			tag: "canary",
		})
		applyUpdateMock.mockResolvedValue(undefined)
		const code = await runUpdate(["--canary", "--force"])
		expect(code).toBe(0)
		expect(applyUpdateMock).toHaveBeenCalledWith({ tag: "canary" })
	})

	it("installs superpowers after successful update", async () => {
		checkForUpdateMock.mockResolvedValue({
			hasUpdate: true,
			latestVersion: "v0.0.80",
			tag: "v0.0.80",
		})
		applyUpdateMock.mockResolvedValue(undefined)
		const code = await runUpdate(["--force"])
		expect(code).toBe(0)
		expect(ensureSuperpowersInstalledMock).toHaveBeenCalledOnce()
	})

	it("does not install superpowers if update fails", async () => {
		checkForUpdateMock.mockResolvedValue({
			hasUpdate: true,
			latestVersion: "v0.0.80",
			tag: "v0.0.80",
		})
		applyUpdateMock.mockRejectedValue(new Error("network error"))
		const code = await runUpdate(["--force"])
		expect(code).toBe(1)
		expect(ensureSuperpowersInstalledMock).not.toHaveBeenCalled()
	})

	it("does not install superpowers on --dry-run", async () => {
		checkForUpdateMock.mockResolvedValue({
			hasUpdate: true,
			latestVersion: "v0.0.80",
			tag: "v0.0.80",
			releaseUrl: "https://example.com",
		})
		const code = await runUpdate(["--dry-run"])
		expect(code).toBe(0)
		expect(applyUpdateMock).not.toHaveBeenCalled()
		expect(ensureSuperpowersInstalledMock).not.toHaveBeenCalled()
	})

	it("succeeds even if superpowers install throws", async () => {
		checkForUpdateMock.mockResolvedValue({
			hasUpdate: true,
			latestVersion: "v0.0.80",
			tag: "v0.0.80",
		})
		applyUpdateMock.mockResolvedValue(undefined)
		ensureSuperpowersInstalledMock.mockRejectedValue(new Error("offline"))
		const code = await runUpdate(["--force"])
		expect(code).toBe(0)
	})
})
