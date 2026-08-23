import { describe, expect, it, vi } from "vitest"
import { formatRsyncFailure, RsyncError } from "./rsync-runner.js"

// Mock runRsync so tests never invoke rsync. formatRsyncFailure is kept real
// so we can assert the exact error string the helper produces.
vi.mock("./rsync-runner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./rsync-runner.js")>()
	return {
		...actual,
		runRsync: vi.fn(),
	}
})

// Mock the config dir so getAgentConfigDir returns a fixed path.
const MOCK_CONFIG_DIR = "/home/test/.config/kimchi/harness"
vi.mock("../../../config.js", () => ({
	getAgentConfigDir: () => MOCK_CONFIG_DIR,
}))

import { SANDBOX_USER } from "./constants.js"
// Import after mocks are registered so the mocked modules are wired in.
import { HARNESS_CONFIG_ALLOWLIST, provisionHarnessConfig, REMOTE_HARNESS_CONFIG_DIR } from "./harness-config.js"
import { runRsync } from "./rsync-runner.js"

const mockedRunRsync = vi.mocked(runRsync)

function baseArgs(overrides: Partial<{ remoteHost: string; authToken: string; signal: AbortSignal }> = {}) {
	return {
		remoteHost: "session-host.example.com",
		authToken: "tok-123",
		...overrides,
	}
}

describe("provisionHarnessConfig", () => {
	it("calls runRsync with the correct options", async () => {
		mockedRunRsync.mockResolvedValueOnce({ fileCount: 0, totalBytes: 0, durationMs: 0 })
		const signal = new AbortController().signal

		await provisionHarnessConfig(baseArgs({ signal }))

		expect(mockedRunRsync).toHaveBeenCalledTimes(1)
		expect(mockedRunRsync).toHaveBeenCalledWith({
			localPath: `${MOCK_CONFIG_DIR}/`,
			remotePath: REMOTE_HARNESS_CONFIG_DIR,
			isSourceDirectory: true,
			remoteHost: "session-host.example.com",
			remoteUser: SANDBOX_USER,
			authToken: "tok-123",
			filesFrom: [...HARNESS_CONFIG_ALLOWLIST],
			deleteExtraneous: false,
			signal,
		})
	})

	it("returns { ok: true } on success", async () => {
		mockedRunRsync.mockResolvedValueOnce({ fileCount: 3, totalBytes: 1024, durationMs: 50 })
		const result = await provisionHarnessConfig(baseArgs())
		expect(result).toEqual({ ok: true })
	})

	it("returns { ok: false, error } on rsync failure without throwing", async () => {
		const err = new RsyncError(23, "rsync: link_stat failed")
		mockedRunRsync.mockRejectedValueOnce(err)

		const result = await provisionHarnessConfig(baseArgs())

		expect(result.ok).toBe(false)
		expect(result.error).toBe(formatRsyncFailure(err))
		expect(result.error).toContain("rsync exited with code 23")
	})

	it("re-throws when the signal is already aborted", async () => {
		const err = new RsyncError(143, "")
		mockedRunRsync.mockRejectedValueOnce(err)
		const controller = new AbortController()
		controller.abort()

		await expect(provisionHarnessConfig(baseArgs({ signal: controller.signal }))).rejects.toBe(err)
	})
})

describe("HARNESS_CONFIG_ALLOWLIST", () => {
	it("contains exactly the synced harness config entries", () => {
		// Directory entries must keep their trailing slash: in --files-from
		// mode a bare `themes` syncs as an empty dir (still exit 0) on both
		// GNU rsync and macOS openrsync.
		expect([...HARNESS_CONFIG_ALLOWLIST]).toEqual(["settings.json", "keybindings.json", "themes/", "models.json"])
	})
})
