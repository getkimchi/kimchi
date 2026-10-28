import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const spawnSync = vi.hoisted(() => vi.fn())
const existsSync = vi.hoisted(() => vi.fn())
const resolveAuxiliaryFilesDir = vi.hoisted(() => vi.fn(() => "/fake-share"))

vi.mock("node:child_process", () => ({ spawnSync }))
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	existsSync,
}))
vi.mock("../auxiliary-files/resolver.js", () => ({ resolveAuxiliaryFilesDir }))

import { runBridge } from "./bridge.js"

describe("kimchi bridge command", () => {
	beforeEach(() => {
		spawnSync.mockReset()
		existsSync.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("setup invokes the bundled installer with the single 'both' client argument", async () => {
		// Regression: runInstaller used to pass separate "claude" and "codex"
		// args, feeding "codex" into install.sh's [vVERSION] slot — every
		// `kimchi bridge setup` failed with "Requested version differs from
		// this package." before installing anything.
		existsSync.mockReturnValue(true)
		spawnSync.mockReturnValue({ status: 0 })

		await runBridge(["setup"])

		const installerCall = spawnSync.mock.calls.find(([file]) => String(file).endsWith("install.sh"))
		expect(installerCall).toBeDefined()
		expect(installerCall?.[1]).toEqual(["install", "both"])
	})

	it("setup enables gateway routing through the bridge CLI after installing", async () => {
		existsSync.mockReturnValue(true)
		spawnSync.mockReturnValue({ status: 0 })

		await runBridge(["setup"])

		const cliCall = spawnSync.mock.calls.find(([file]) => String(file).endsWith("kimchi-bridge"))
		expect(cliCall?.[1]).toEqual(["gateway", "enable"])
	})

	it("setup fails without spawning the gateway enable when the installer fails", async () => {
		existsSync.mockReturnValue(true)
		spawnSync.mockReturnValue({ status: 1 })

		const code = await runBridge(["setup"])

		expect(code).toBe(1)
		expect(spawnSync).toHaveBeenCalledTimes(1)
	})

	it("status reports the missing CLI with stale-routing guidance and falls back to installer receipts", async () => {
		// The CLI shim is missing while the bundled installer package exists.
		existsSync.mockImplementation((path: unknown) => !String(path).endsWith("kimchi-bridge"))
		spawnSync.mockReturnValue({ status: 0 })

		const code = await runBridge(["status"])

		expect(code).toBe(1)
		const statusCall = spawnSync.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === "status")
		expect(statusCall?.[1]).toEqual(["status", "both"])
	})

	it("status delegates to the bridge CLI when the shim exists", async () => {
		existsSync.mockReturnValue(true)
		spawnSync.mockReturnValue({ status: 0 })

		const code = await runBridge(["status"])

		expect(code).toBe(0)
		const cliCall = spawnSync.mock.calls.find(([file]) => String(file).endsWith("kimchi-bridge"))
		expect(cliCall?.[1]).toEqual(["status"])
	})

	it("remove invokes the bundled installer with the 'both' client argument", async () => {
		existsSync.mockReturnValue(true)
		spawnSync.mockReturnValue({ status: 0 })

		await runBridge(["remove"])

		const installerCall = spawnSync.mock.calls.find(([file]) => String(file).endsWith("install.sh"))
		expect(installerCall?.[1]).toEqual(["uninstall", "both"])
	})
})
