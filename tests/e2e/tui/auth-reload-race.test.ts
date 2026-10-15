import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Chatting must keep working while another process syncs the shared
 * auth.json concurrently. Every chat request re-reads the provider
 * credential, so the lock-free read must heal transient tears (see
 * src/pi-auth-storage.test.ts). The churner cycles partial-5ms → valid-25ms
 * writes — the tear window sits inside the retry backoff. Sessions must
 * never surface "Credential store read failed" or "API key auth failed".
 */
test("chat session keeps working while auth.json is synced concurrently", async ({ terminal }) => {
	const responses = [1, 2, 3, 4, 5, 6].map((n) => ({ stream: [`Turn ${n}`, " completed."] }))
	await runKimchiSession(
		terminal,
		{
			artifactName: "auth-reload-race",
			providerId: "kimchi-dev/openai",
			responses,
			seedHome: (homeDir) => {
				// Served models carry provider "openai", so the launchable id is
				// the sub-block "kimchi-dev/openai"; auth.json must match.
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
const valid = fs.readFileSync(p);
const partial = '{ "kimchi-dev/openai": { "type": "api_key", "key": "fa';
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const end = Date.now() + 90000;
while (Date.now() < end) {
  // partial, hold 5ms, then complete — the 10ms retry backoff outlives it
  fs.writeFileSync(p, partial);
  wait(5);
  fs.writeFileSync(p, valid);
  fs.chmodSync(p, 0o600);
  wait(25);
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
