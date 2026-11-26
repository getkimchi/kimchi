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

import { SANDBOX_HOME, SANDBOX_USER } from "./constants.js"
// Import after mocks are registered so the mocked modules are wired in.
import {
	buildRemoteEnvProbeCommand,
	HARNESS_CONFIG_ALLOWLIST,
	provisionHarnessConfig,
	REMOTE_HARNESS_CONFIG_DIR,
	resolveRemoteHarnessConfigDir,
} from "./harness-config.js"
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
	it("calls runRsync with the correct options for a legacy remote", async () => {
		mockedRunRsync.mockResolvedValueOnce({ fileCount: 0, totalBytes: 0, durationMs: 0 })
		const signal = new AbortController().signal

		await provisionHarnessConfig({ ...baseArgs({ signal }), _probe: async () => "legacy" })

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

	it("targets the remote's envs/default harness for a fresh or unprobed remote", async () => {
		mockedRunRsync.mockResolvedValueOnce({ fileCount: 0, totalBytes: 0, durationMs: 0 })

		for (const probe of [async () => "fresh", async () => undefined]) {
			mockedRunRsync.mockClear()
			await provisionHarnessConfig({ ...baseArgs(), _probe: probe })
			expect(mockedRunRsync).toHaveBeenCalledWith(
				expect.objectContaining({
					remotePath: `${SANDBOX_HOME}/.config/kimchi/envs/default/harness`,
				}),
			)
		}
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

describe("remote default-env probe helpers", () => {
	it("buildRemoteEnvProbeCommand mirrors resolveKimchiEnv's probe", () => {
		const cmd = buildRemoteEnvProbeCommand()
		// Both visible and dotfile entries of the remote kimchi dir are scanned.
		expect(cmd).toContain("/.config/kimchi/*")
		expect(cmd).toContain("/.config/kimchi/.[!.]*")
		// Only envs/ is exempt — anything else means legacy state.
		expect(cmd).toContain('[ "$b" = envs ] || { echo legacy; exit 0; }')
		expect(cmd.trim().endsWith("echo fresh")).toBe(true)
	})

	it("resolveRemoteHarnessConfigDir targets the legacy dir only for an explicit legacy probe", () => {
		const envsDefault = `${SANDBOX_HOME}/.config/kimchi/envs/default/harness`
		expect(resolveRemoteHarnessConfigDir("legacy\n")).toBe(REMOTE_HARNESS_CONFIG_DIR)
		// Fresh remote, probe failure, or noisy output all fall back to
		// envs/default — the non-destructive direction: creating envs/ never
		// flips a remote that already resolved legacy.
		expect(resolveRemoteHarnessConfigDir("fresh")).toBe(envsDefault)
		expect(resolveRemoteHarnessConfigDir(undefined)).toBe(envsDefault)
		expect(resolveRemoteHarnessConfigDir("ssh warning\nfresh")).toBe(envsDefault)
	})
})
