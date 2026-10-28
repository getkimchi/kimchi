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
		// this package." before installing anything. The installer is spawned
		// through bash: some release layouts shipped install.sh without the
		// executable bit and a direct spawn failed with EACCES.
		existsSync.mockReturnValue(true)
		spawnSync.mockReturnValue({ status: 0 })

		await runBridge(["setup"])

		expect(spawnSync).toHaveBeenCalledWith(
			"bash",
			[expect.stringMatching(/install\.sh$/), "install", "both"],
			expect.objectContaining({ stdio: "inherit" }),
		)
	})

	it("setup enables gateway routing through the bridge CLI after installing", async () => {
		existsSync.mockReturnValue(true)
		spawnSync.mockReturnValue({ status: 0 })

		await runBridge(["setup"])

		const cliCall = spawnSync.mock.calls.find(([file]) => String(file).endsWith("kimchi-bridge"))
		expect(cliCall?.[1]).toEqual(["gateway", "enable"])
	})

	it("reports a spawn failure that Bun surfaces as undefined status", async () => {
		// Regression: on EACCES Bun's spawnSync leaves status undefined, and
		// the old `status === null` guard skipped the diagnostic — setup
		// failed with no output at all.
		existsSync.mockReturnValue(true)
		spawnSync.mockReturnValue({ status: undefined, error: new Error("EACCES: permission denied") })

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
		expect(spawnSync).toHaveBeenCalledWith(
			"bash",
			[expect.stringMatching(/install\.sh$/), "status", "both"],
			expect.objectContaining({ stdio: "inherit" }),
		)
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

		expect(spawnSync).toHaveBeenCalledWith(
			"bash",
			[expect.stringMatching(/install\.sh$/), "uninstall", "both"],
			expect.objectContaining({ stdio: "inherit" }),
		)
	})
})
