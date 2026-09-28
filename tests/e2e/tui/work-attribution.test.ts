import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { expect, Key, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)
const models = [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }]

test("work and request IDs are durable before the first reply, and commits belong to that work", async ({
	terminal,
}) => {
	let releaseResponse = () => {}
	const held = new Promise<void>((resolve) => {
		releaseResponse = resolve
	})
	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "work-attribution",
				gitInit: true,
				models,
				seedHome(home, cwd) {
					execFileSync("git", ["config", "user.name", "Attribution Test"], { cwd })
					execFileSync("git", ["config", "user.email", "attribution@example.invalid"], { cwd })
					const configPath = join(home, ".config/kimchi/config.json")
					const config = JSON.parse(readFileSync(configPath, "utf8"))
					writeFileSync(configPath, JSON.stringify({ ...config, telemetry: { enabled: false } }))
				},
				responses: [
					{
						holdUntil: held,
						toolCalls: [
							{
								function: {
									name: "bash",
									arguments: JSON.stringify({
										command: "printf 'hello\\n' > hello.txt && git add hello.txt && git commit -m 'Add hello'",
									}),
								},
							},
						],
					},
					{ stream: ["Created the attribution test commit."] },
				],
			},
			async (fixture, trace) => {
				terminal.submit("Create and commit hello.txt in this test repository.")
				const deadline = Date.now() + 15_000
				while (
					!fixture.fake.requests.some((request) => request.url.includes("/chat/completions")) &&
					Date.now() < deadline
				)
					await sleep(50)
				const request = fixture.fake.requests.find((item) => item.url.includes("/chat/completions"))
				expect(request).toBeDefined()
				const ledgerDir = join(fixture.agentDir, "work-attribution")
				const records = () =>
					readdirSync(ledgerDir).flatMap((file) =>
						readFileSync(join(ledgerDir, file), "utf8")
							.trim()
							.split("\n")
							.map((line) => JSON.parse(line)),
					)
				const started = records().filter((record) => record.type === "request")
				expect(started.length).toBe(1)
				expect(started[0].requestId).toBe(request?.headers["x-request-id"])
				expect(started[0].workId).toMatch(/^[0-9a-f-]{36}$/)
				trace.step("request and work IDs on disk while provider reply is held, telemetry disabled")
				releaseResponse()
				await expect(terminal.getByText("Created the attribution test commit.", { full: true })).toBeVisible()
				const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.workDir, encoding: "utf8" }).trim()
				const commits = records().filter((record) => record.type === "commit")
				expect(commits.length).toBe(1)
				expect(commits[0].sha).toBe(sha)
				expect(commits[0].workId).toBe(started[0].workId)
				expect(
					new Set(
						records()
							.filter((record) => record.type === "request")
							.map((record) => record.requestId),
					).size,
				).toBe(2)
				trace.step("real Git commit and second request retain original work ID")
			},
		)
	} finally {
		releaseResponse()
	}
})

test("a new session continues a saved plan's work before its first model call", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "work-attribution-plan",
			gitInit: true,
			models,
			extraArgs: ["--plan=true"],
			exitMarker: "PLANNING_SESSION_EXITED",
			responses: [
				{
					toolCalls: [
						{
							function: {
								name: "submit_plan",
								arguments: JSON.stringify({ plan: "# Attribution Plan\n\nAdd a greeting." }),
							},
						},
					],
				},
				{ stream: ["Continuing the saved attribution plan."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Plan a greeting feature.")
			await waitForText(terminal, "Execute the plan")
			const planPath = join(fixture.workDir, ".kimchi/plans/attribution-plan.md")
			const plan = readFileSync(planPath, "utf8")
			const workId = /<!-- kimchi-work-id: ([0-9a-f-]+) -->/.exec(plan)?.[1]
			expect(workId).toBeDefined()
			trace.step("planning produced a saved plan carrying work identity")
			terminal.keyPress(Key.Escape)
			await expect(
				terminal.getByText("Plan complete. How would you like to proceed?", { full: false }),
			).not.toBeVisible()
			terminal.submit("/quit")
			await waitForText(terminal, "PLANNING_SESSION_EXITED", { full: false })
			launchKimchi(terminal, fixture, [], fixture.seedEnv)
			await waitForText(terminal, PROMPT_READY, { full: false })
			terminal.submit(`/work ${planPath}`)
			await waitForText(terminal, `Work ID: ${workId}`)
			terminal.submit("Implement the saved plan.")
			await waitForText(terminal, "Continuing the saved attribution plan.")
			const ledgerDir = join(fixture.agentDir, "work-attribution")
			const requests = readdirSync(ledgerDir)
				.flatMap((file) =>
					readFileSync(join(ledgerDir, file), "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line)),
				)
				.filter((record) => record.type === "request")
			expect(new Set(requests.map((record) => record.sessionId)).size).toBe(2)
			expect(new Set(requests.map((record) => record.workId))).toEqual(new Set([workId]))
			trace.step("planning and implementation sessions share work identity")
		},
	)
})
