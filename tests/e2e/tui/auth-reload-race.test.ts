import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Chatting must keep working while another process syncs the shared
 * auth.json concurrently (second session, `auth check`, upstream OAuth
 * refresh). The auth-storage lock-free-reads hunk resolves every
 * file-backed credential read without the write lock; the first read after
 * an external revision change must yield the bare credential map (see the
 * seam tests in src/pi-auth-storage.test.ts for the wrapper-shape bug this
 * hunk introduced and #1424 consumer-fixed).
 *
 * The churner rewrites auth.json with a truncated document every 25ms, so a
 * session that DID re-read credentials mid-sync would observe a partial
 * file — torn reads heal to the last valid snapshot instead of surfacing
 * "JSON Parse error" or "API key auth failed".
 */
test("chat session keeps working while auth.json is synced concurrently", async ({ terminal }) => {
	const responses = [1, 2, 3].map((n) => ({ stream: [`Turn ${n}`, " completed."] }))
	await runKimchiSession(
		terminal,
		{
			artifactName: "auth-reload-race",
			providerId: "kimchi-dev/openai",
			responses,
			seedHome: (homeDir) => {
				// The startup model refresh regenerates the managed kimchi-dev*
				// blocks from /v1/models/metadata; the served models carry
				// provider "openai", so the launchable provider id is the
				// sub-block "kimchi-dev/openai" — same shape as real sessions
				// ("kimchi-dev/anthropic" etc.). auth.json seeding must match.
				const agentDir = join(homeDir, ".config", "kimchi", "harness")
				const modelsPath = join(agentDir, "models.json")
				const models = JSON.parse(readFileSync(modelsPath, "utf-8"))
				models.providers["kimchi-dev/openai"].apiKey = "$KIMCHI_API_KEY"
				writeFileSync(modelsPath, JSON.stringify(models, null, "\t"))
				writeFileSync(
					join(agentDir, "auth.json"),
					JSON.stringify({ "kimchi-dev/openai": { type: "api_key", key: "fake" } }),
					{ mode: 0o600 },
				)
			},
		},
		async (fixture, trace) => {
			const authPath = join(fixture.agentDir, "auth.json")
			const churner = spawn(
				process.execPath,
				[
					"-e",
					`const fs = require("node:fs");
const p = process.argv[1];
const partial = '{ "kimchi-dev/openai": { "type": "api_key", "key": "fa';
const end = Date.now() + 60000;
while (Date.now() < end) {
  fs.writeFileSync(p, partial);
  fs.chmodSync(p, 0o600);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}`,
					authPath,
				],
				{ stdio: "ignore" },
			)
			trace.step("churner started")
			try {
				for (const [i, response] of responses.entries()) {
					terminal.submit(`Say thing ${i + 1}`)
					await expect(terminal.getByText(response.stream.join(""), { full: true })).toBeVisible()
					trace.step(`turn ${i + 1} completed`)
				}
			} finally {
				churner.kill("SIGKILL")
			}
		},
	)
})
