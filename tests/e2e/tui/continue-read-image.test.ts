// Regression test for the --continue crash reported with a read-image session:
//
//   TypeError: WeakMap keys must be objects or non-registered symbols
//
// Resuming a session whose transcript contains a collapsed `read` tool result
// with an image block crashed on replay. The read-image collapse patch
// (src/extensions/tool-rendering.ts) cleared imageComponents/imageSpacers but
// left imageSources stale, so the next upstream updateDisplay matched the stale
// source against an empty imageComponents array, reused `undefined` and handed
// it to addChild — where the tool-grouping parent tracker
// (src/extensions/tool-grouping.ts) threw on the non-object WeakMap key.
//
// The crash only fires on image-capable terminals (upstream gates on
// `caps.images && showImages`). The PTY harness reports TERM=xterm-256color,
// so PI_IMAGE_PROTOCOL=kitty (the supported pi-tui capability override) forces
// the image path on both launches.

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import {
	fullText,
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { makeSolidPng } from "./support/png.js"

test.use(TUI_TEST_CONFIG)

const VISION_MODEL = { slug: "vision", displayName: "Fake Vision", input: ["text", "image"] as ("text" | "image")[] }
const KITTY_ENV = { PI_IMAGE_PROTOCOL: "kitty" }

test("resuming a session with a collapsed read image does not crash", async ({ terminal }) => {
	const exitMarker = "__CONTINUE_READ_IMAGE_EXITED__"
	await runKimchiSession(
		terminal,
		{
			artifactName: "continue-read-image",
			models: [VISION_MODEL],
			initialModel: VISION_MODEL.slug,
			env: KITTY_ENV,
			exitMarker,
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "shot.png"), makeSolidPng(32, 32))
			},
			responses: [
				{
					toolCalls: [
						{
							id: "call_read_image",
							function: { name: "read", arguments: JSON.stringify({ path: "shot.png" }) },
						},
					],
				},
				{ stream: ["Read the screenshot."] },
				{ stream: ["Resumed and healthy."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("read shot.png")
			await waitForText(terminal, "Read the screenshot.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("session transcript holds a collapsed read-image tool result")

			terminal.submit("/quit")
			await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS })

			// Relaunch with --continue, exactly the reported flow. launchKimchi's
			// extraEnv defaults to {}, so force kitty on the resumed leg again.
			launchKimchi(terminal, fixture, ["--continue"], KITTY_ENV)
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
			expect(fullText(terminal)).not.toContain("WeakMap keys must be objects")
			trace.step("resume rendered the transcript without the WeakMap crash")

			terminal.submit("still alive?")
			await waitForText(terminal, "Resumed and healthy.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("resumed session accepts a new turn")
		},
	)
})
