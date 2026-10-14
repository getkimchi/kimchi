import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Chatting must keep working while another process syncs the shared
 * auth.json concurrently (second session, `auth check`, upstream OAuth
 * refresh). Every chat request resolves the provider credential, so a
 * running session re-reads auth.json on every turn. The lock-free read in
 * dist/core/auth-storage.js is the path that must heal transient tears
 * (see the regression tests in src/pi-auth-storage.test.ts).
 *
 * The churner models an upstream modify() truncate-then-write cycle: it
 * writes a partial document, waits 5ms (inside the lock-free retry
 * backoff), writes the valid snapshot back, and repeats every 25ms. A
 * reading session SHOULD never surface "Credential store read failed" or
 * "API key auth failed".
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
// Snapshot the valid auth.json once at start; persist across the loop.
const valid = fs.readFileSync(p);
const partial = '{ "kimchi-dev/openai": { "type": "api_key", "key": "fa';
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const end = Date.now() + 90000;
while (Date.now() < end) {
  // Simulate upstream modify() truncate-then-write under lock: partial,
  // hold 5ms, then completed write. A lock-free read inside the 5ms
  // window observes the tear; the lock-free retry backoff (10ms) must
  // outlive it.
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
