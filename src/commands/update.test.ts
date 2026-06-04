import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const isHomebrewInstallMock = vi.fn(() => false)
const checkForUpdateMock = vi.fn()
const applyUpdateMock = vi.fn()
const getVersionMock = vi.fn(() => "v0.0.23")
interface ConfiguredPackageFixture {
	source: string
	scope: "user" | "project"
	filtered: boolean
	installedPath?: string
}
const listConfiguredPackagesMock = vi.fn((): ConfiguredPackageFixture[] => [])
const packageUpdateMock = vi.fn(async (_source?: string): Promise<void> => {})
const setProgressCallbackMock = vi.fn()
const settingsManagerCreateMock = vi.fn((_cwd: unknown, _agentDir: unknown) => ({}))

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()
	return {
		...actual,
		getAgentDir: () => "/agent",
		SettingsManager: {
			create: (cwd: unknown, agentDir: unknown) => settingsManagerCreateMock(cwd, agentDir),
		},
		DefaultPackageManager: vi.fn().mockImplementation(() => ({
			listConfiguredPackages: listConfiguredPackagesMock,
			setProgressCallback: setProgressCallbackMock,
			update: packageUpdateMock,
		})),
	}
})

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
		listConfiguredPackagesMock.mockReset()
		listConfiguredPackagesMock.mockReturnValue([])
		packageUpdateMock.mockReset()
		setProgressCallbackMock.mockReset()
		settingsManagerCreateMock.mockReset()
		settingsManagerCreateMock.mockReturnValue({})
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

	it("rejects global Pi flags that are not valid for update", async () => {
		const code = await runUpdate(["--model", "kimchi-dev/kimi-k2.6"])
		expect(code).toBe(2)
		expect(errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")).toContain("unknown flag: --model")
	})

	it("keeps -f as an alias for --force", async () => {
		checkForUpdateMock.mockResolvedValue({
			hasUpdate: true,
			latestVersion: "0.0.24",
			tag: "v0.0.24",
		})
		applyUpdateMock.mockResolvedValue(undefined)

		const code = await runUpdate(["self", "-f"])

		expect(code).toBe(0)
		expect(applyUpdateMock).toHaveBeenCalledWith({ tag: "v0.0.24" })
	})

	it("rejects --extension when the next token is another flag", async () => {
		const code = await runUpdate(["--extension", "--force"])
		expect(code).toBe(2)
		expect(errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")).toContain("missing value for --extension")
	})

	it("rejects conflicting package selectors", async () => {
		const code = await runUpdate(["--extension", "context-mode", "--extensions"])
		expect(code).toBe(2)
		expect(errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")).toContain(
			"--extension cannot be combined with --self or --extensions",
		)
	})
})

describe("runUpdate Homebrew branch", () => {
	let logSpy: ReturnType<typeof vi.spyOn>
	let errSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		isHomebrewInstallMock.mockReset()
		checkForUpdateMock.mockReset()
		applyUpdateMock.mockReset()
		listConfiguredPackagesMock.mockReset()
		listConfiguredPackagesMock.mockReturnValue([])
		packageUpdateMock.mockReset()
		setProgressCallbackMock.mockReset()
		settingsManagerCreateMock.mockReset()
		settingsManagerCreateMock.mockReturnValue({})
	})

	afterEach(() => {
		logSpy.mockRestore()
		errSpy.mockRestore()
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
	let errSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		isHomebrewInstallMock.mockReset()
		isHomebrewInstallMock.mockReturnValue(false)
		checkForUpdateMock.mockReset()
		applyUpdateMock.mockReset()
		listConfiguredPackagesMock.mockReset()
		listConfiguredPackagesMock.mockReturnValue([])
		packageUpdateMock.mockReset()
		setProgressCallbackMock.mockReset()
		settingsManagerCreateMock.mockReset()
		settingsManagerCreateMock.mockReturnValue({})
		ensureSuperpowersInstalledMock.mockReset()
		ensureSuperpowersInstalledMock.mockResolvedValue(true)
	})

	afterEach(() => {
		logSpy.mockRestore()
		errSpy.mockRestore()
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
})

describe("runUpdate package targets", () => {
	let logSpy: ReturnType<typeof vi.spyOn>
	let errSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		isHomebrewInstallMock.mockReset()
		isHomebrewInstallMock.mockReturnValue(false)
		checkForUpdateMock.mockReset()
		checkForUpdateMock.mockResolvedValue({ hasUpdate: false })
		applyUpdateMock.mockReset()
		ensureSuperpowersInstalledMock.mockReset()
		ensureSuperpowersInstalledMock.mockResolvedValue(true)
		listConfiguredPackagesMock.mockReset()
		listConfiguredPackagesMock.mockReturnValue([
			{ source: "npm:context-mode", scope: "user", filtered: false, installedPath: "/packages/context-mode" },
		])
		packageUpdateMock.mockReset()
		packageUpdateMock.mockResolvedValue(undefined)
		setProgressCallbackMock.mockReset()
		settingsManagerCreateMock.mockReset()
		settingsManagerCreateMock.mockReturnValue({})
	})

	afterEach(() => {
		logSpy.mockRestore()
		errSpy.mockRestore()
	})

	it("updates a package by bare display name", async () => {
		const code = await runUpdate(["context-mode"])

		expect(code).toBe(0)
		expect(packageUpdateMock).toHaveBeenCalledWith("npm:context-mode")
		expect(checkForUpdateMock).not.toHaveBeenCalled()
		expect(logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")).toContain("Updated npm:context-mode")
	})

	it("updates a package by --extension display name", async () => {
		const code = await runUpdate(["--extension", "context-mode"])

		expect(code).toBe(0)
		expect(packageUpdateMock).toHaveBeenCalledWith("npm:context-mode")
		expect(checkForUpdateMock).not.toHaveBeenCalled()
	})

	it("updates all packages before checking Kimchi self-updates on bare update", async () => {
		const code = await runUpdate([])

		expect(code).toBe(0)
		expect(packageUpdateMock).toHaveBeenCalledWith(undefined)
		expect(checkForUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ skipCache: true }))
		const out = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
		expect(out).toContain("Updated packages")
		expect(out).toContain("kimchi: already up to date")
	})

	it("updates all packages only with --extensions", async () => {
		const code = await runUpdate(["--extensions"])

		expect(code).toBe(0)
		expect(packageUpdateMock).toHaveBeenCalledWith(undefined)
		expect(checkForUpdateMock).not.toHaveBeenCalled()
	})

	it("keeps --dry-run as a Kimchi self-update check", async () => {
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
