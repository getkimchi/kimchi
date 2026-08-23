import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const testOnLinux = process.platform === "linux" ? test : test.skip

testOnLinux("does not invoke wl-paste while idle on Wayland", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "clipboard-wayland-idle",
			responses: [],
			seedHome(homeDir) {
				const binDir = join(homeDir, "bin")
				const logPath = join(homeDir, "clipboard-helper.log")
				mkdirSync(binDir)
				writeFileSync(logPath, "")
				const shim = `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\n`
				for (const helper of ["wl-paste", "xclip"]) {
					const helperPath = join(binDir, helper)
					writeFileSync(helperPath, shim)
					chmodSync(helperPath, 0o755)
				}
				return {
					env: {
						DISPLAY: "",
						PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
						WAYLAND_DISPLAY: "wayland-test",
					},
				}
			},
		},
		async (fixture, trace) => {
			await new Promise((resolve) => setTimeout(resolve, 2200))
			const logPath = join(fixture.homeDir, "clipboard-helper.log")
			expect(readFileSync(logPath, "utf8")).toBe("")
			trace.step("no background clipboard helper invocation after two polling intervals")
		},
	)
})
