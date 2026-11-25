import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { poll } from "@microsoft/tui-test/lib/utils/poll.js"
import { viewText, waitForText } from "./support/assertions.js"
import {
	BINARY_PATH,
	createKimchiFixture,
	createKimchiSessionController,
	PACKAGE_DIR,
	THROWAWAY_INSTALL_DIR,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("the latest regular TUI automatically switches to fullscreen once", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		responses: [{ stream: ["Use the LRU cache."] }],
		seedHome: (homeDir) => {
			// A release-shaped throwaway install avoids getVersion()'s deliberate
			// 0.0.0 → dev mapping, which must not count as latest-release proof.
			const version = "1.2.3"
			const installDir = join(homeDir, THROWAWAY_INSTALL_DIR)
			const binaryPath = join(installDir, "bin", "kimchi")
			const packageDir = join(installDir, "share", "kimchi")
			mkdirSync(join(installDir, "bin"), { recursive: true })
			mkdirSync(packageDir, { recursive: true })
			copyFileSync(BINARY_PATH, binaryPath, constants.COPYFILE_FICLONE)
			for (const entry of readdirSync(PACKAGE_DIR)) {
				if (entry !== "package.json") symlinkSync(join(PACKAGE_DIR, entry), join(packageDir, entry))
			}
			const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf-8")) as Record<string, unknown>
			writeFileSync(join(packageDir, "package.json"), JSON.stringify({ ...pkg, version }))

			const cacheDir = join(homeDir, ".cache")
			mkdirSync(join(cacheDir, "kimchi"), { recursive: true })
			writeFileSync(
				join(cacheDir, "kimchi", "state.json"),
				JSON.stringify({
					repos: {
						"getkimchi/kimchi": { checked_at: new Date().toISOString(), latest_version: `v${version}` },
					},
				}),
			)
			return {
				binaryPath,
				env: { PI_PACKAGE_DIR: packageDir, XDG_CACHE_HOME: cacheDir, KIMCHI_NO_UPDATE_CHECK: "" },
			}
		},
	})
	const session = createKimchiSessionController(terminal, fixture, { extraEnv: fixture.seedEnv })

	try {
		await session.start()
		terminal.submit("/btw Which cache?")
		await waitForText(
			terminal,
			(text) => text.includes("Side chat · Which cache?") || text.includes("Side chat needs the fullscreen TUI mode"),
			{ full: false },
		)
		expect(viewText(terminal)).toContain("Side chat · Which cache?")
		await waitForText(terminal, "Use the LRU cache.", { full: false })

		const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8")) as Record<
			string,
			unknown
		>
		expect(settings.tuiMode).toBe("fullscreen")
		expect(existsSync(join(fixture.agentDir, "one-time-fullscreen.json"))).toBe(true)

		// Close the side editor before quitting so /quit reaches main rather than
		// being submitted as another side-chat prompt.
		terminal.submit("/close")
		await poll(() => !viewText(terminal).includes("Side chat · Which cache?"), 100, 5_000).then((closed) => {
			expect(closed).toBe(true)
		})
		// The migrated setting is now fullscreen. Simulate the user deliberately
		// choosing regular again before starting the next session.
		settings.tuiMode = "regular"
		writeFileSync(join(fixture.agentDir, "settings.json"), JSON.stringify(settings))
		await session.restart()
		terminal.submit("/btw Are we regular again?")
		await waitForText(terminal, "Side chat needs the fullscreen TUI mode", { full: false })
		expect(viewText(terminal)).not.toContain("Side chat · Are we regular again?")
	} finally {
		await session.quit()
		await fixture.stop()
	}
})
