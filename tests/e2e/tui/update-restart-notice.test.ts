import { constants, copyFileSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import {
	BINARY_PATH,
	PACKAGE_DIR,
	runKimchiSession,
	THROWAWAY_INSTALL_DIR,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

// Wide enough for the notice beside the yolo warning: the info line drops it
// when both don't fit.
test.use({ ...TUI_TEST_CONFIG, columns: 160 })

const RESTART_NOTICE = "Update installed · Restart to update"
const FIRST_TICK_DELAY_MS = 10_000

function writeInstalledVersion(packageDir: string, version: string): void {
	const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf-8")) as Record<string, unknown>
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ ...pkg, version }))
}

test("a session offers a restart once another session has installed a newer version", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "update-restart-notice",
			responses: [],
			seedHome: (homeDir) => {
				// A throwaway install with a release version: dev builds never run the
				// updater, and kimchi only honours a package dir next to its binary
				// when the versions match. Bumping its version later is what another
				// session's install looks like from here.
				const installDir = join(homeDir, THROWAWAY_INSTALL_DIR)
				const binaryPath = join(installDir, "bin", "kimchi")
				const packageDir = join(installDir, "share", "kimchi")
				mkdirSync(join(installDir, "bin"), { recursive: true })
				mkdirSync(packageDir, { recursive: true })
				copyFileSync(BINARY_PATH, binaryPath, constants.COPYFILE_FICLONE)
				for (const entry of readdirSync(PACKAGE_DIR)) {
					if (entry !== "package.json") symlinkSync(join(PACKAGE_DIR, entry), join(packageDir, entry))
				}
				writeInstalledVersion(packageDir, "1.0.0")

				// The update tick fires ~10s in. A fresh check cache naming 1.0.0 as
				// the latest release keeps it away from GitHub.
				const cacheDir = join(homeDir, ".cache")
				mkdirSync(join(cacheDir, "kimchi"), { recursive: true })
				writeFileSync(
					join(cacheDir, "kimchi", "state.json"),
					JSON.stringify({
						repos: {
							"getkimchi/kimchi": { checked_at: new Date().toISOString(), latest_version: "v1.0.0" },
						},
					}),
				)

				return {
					binaryPath,
					data: packageDir,
					env: { PI_PACKAGE_DIR: packageDir, XDG_CACHE_HOME: cacheDir, KIMCHI_NO_UPDATE_CHECK: "" },
				}
			},
		},
		async (fixture) => {
			await expect(terminal.getByText("Auto-update is on", { full: true })).toBeVisible()
			await expect(terminal.getByText(RESTART_NOTICE, { full: true })).not.toBeVisible()

			writeInstalledVersion(fixture.seedResult as string, "1.1.0")
			// A new session re-reads the installed version straight away, without
			// waiting for the one-minute poll.
			terminal.submit("/new")

			await expect(terminal.getByText(RESTART_NOTICE, { full: true })).toBeVisible()

			// The replaced session's first tick would fire about now. Its loop must
			// be gone: touching the old session's UI would kill the process.
			await new Promise((resolve) => setTimeout(resolve, FIRST_TICK_DELAY_MS + 1_000))
			await expect(terminal.getByText("is stale after session replacement", { full: true })).not.toBeVisible()
			await expect(terminal.getByText(RESTART_NOTICE, { full: true })).toBeVisible()
		},
	)
})
