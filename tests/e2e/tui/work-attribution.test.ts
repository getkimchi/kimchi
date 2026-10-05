import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { expect, Key, test } from "@microsoft/tui-test"
import { check } from "proper-lockfile"
import { fullText, waitForText } from "./support/assertions.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)
const models = [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }]
const readLedger = (directory: string) =>
	readdirSync(directory)
		.filter((file) => file.endsWith(".jsonl"))
		.flatMap((file) =>
			readFileSync(join(directory, file), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		)

async function waitForSummary(
	agentDir: string,
	workId: string,
	minimum: Partial<Record<"sessions" | "requests" | "plans" | "commits", number>>,
) {
	const path = join(agentDir, "work", workId, "work.json")
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		try {
			const summary = JSON.parse(readFileSync(path, "utf8"))
			if (Object.entries(minimum).every(([key, count]) => summary[key]?.length >= count)) return summary
		} catch {}
		await sleep(50)
	}
	throw new Error(`Work summary did not become ready: ${path}`)
}

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
				const records = () => readLedger(ledgerDir)
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
				const namingDeadline = Date.now() + 15_000
				const completionRequests = () => fixture.fake.requests.filter((item) => item.url.endsWith("/chat/completions"))
				const isNamingRequest = (url: string) => url === "/chat/completions"
				while (!completionRequests().some((item) => isNamingRequest(item.url)) && Date.now() < namingDeadline)
					await sleep(50)
				const sent = completionRequests()
				expect(sent.filter((item) => isNamingRequest(item.url)).length).toBe(1)
				expect(sent.filter((item) => !isNamingRequest(item.url)).length).toBe(2)
				const attempts = records().filter((record) => record.type === "request")
				expect(attempts.length).toBe(sent.length)
				expect(new Set(attempts.map((record) => record.requestId)).size).toBe(sent.length)
				for (const dispatched of sent) {
					const body = dispatched.body
					const model = typeof body === "object" && body !== null && "model" in body ? body.model : undefined
					expect(attempts.find((record) => record.requestId === dispatched.headers["x-request-id"])).toMatchObject({
						workId: started[0].workId,
						model,
					})
				}
				const summary = await waitForSummary(fixture.agentDir, started[0].workId, { requests: sent.length, commits: 1 })
				expect(summary).toMatchObject({
					version: 1,
					workId: started[0].workId,
					sessions: [started[0].sessionId],
					plans: [],
				})
				expect(
					summary.requests.find((item: { requestId: string }) => item.requestId === request?.headers["x-request-id"]),
				).toMatchObject({ sessionId: started[0].sessionId, model: "basic" })
				expect(summary.commits[0]).toMatchObject({ sha, sessionId: started[0].sessionId })
				expect(summary.requests[0].workId).toBeUndefined()
				trace.step("readable work summary contains header request IDs and the real Git commit")
			},
		)
	} finally {
		releaseResponse()
	}
})

test("a new worktree continues a retained plan after its original worktree is deleted", async ({ terminal }) => {
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
			terminal.submit("/quit")
			await waitForText(terminal, "PLANNING_SESSION_EXITED", { full: false })
			execFileSync(
				"git",
				[
					"-c",
					"user.name=Attribution Test",
					"-c",
					"user.email=attribution@example.invalid",
					"-c",
					"commit.gpgSign=false",
					"commit",
					"--allow-empty",
					"-m",
					"Plan test baseline",
				],
				{ cwd: fixture.workDir },
			)
			const planningTree = join(fixture.workDir, "planning")
			const implementingTree = join(fixture.workDir, "implementing")
			for (const [branch, path] of [
				["planning", planningTree],
				["implementing", implementingTree],
			])
				execFileSync("git", ["worktree", "add", "-b", branch, path], { cwd: fixture.workDir })
			launchKimchi(terminal, { ...fixture, workDir: planningTree }, ["--plan=true"], fixture.seedEnv, {
				exitMarker: "PLAN_WORKTREE_EXITED",
			})
			await waitForText(terminal, PROMPT_READY, { full: false })
			terminal.submit("Plan a greeting feature.")
			await waitForText(terminal, "Execute the plan")
			const planPath = join(realpathSync(planningTree), ".kimchi/plans/attribution-plan.md")
			const plan = readFileSync(planPath, "utf8")
			const workId = /<!-- kimchi-work-id: ([0-9a-f-]+) -->/.exec(plan)?.[1]
			if (!workId) throw new Error("Saved plan has no work ID")
			const planned = await waitForSummary(fixture.agentDir, workId, { plans: 1 })
			const snapshotPath = planned.plans[0].snapshotPath
			expect(typeof snapshotPath).toBe("string")
			expect(readFileSync(snapshotPath, "utf8")).toBe(plan)
			trace.step("planning produced a saved plan carrying work identity")
			terminal.keyPress(Key.Escape)
			await expect(
				terminal.getByText("Plan complete. How would you like to proceed?", { full: false }),
			).not.toBeVisible()
			terminal.submit("/quit")
			await waitForText(terminal, "PLAN_WORKTREE_EXITED", { full: false })
			execFileSync("git", ["worktree", "remove", "--force", planningTree], { cwd: fixture.workDir })
			expect(existsSync(planPath)).toBe(false)
			launchKimchi(terminal, { ...fixture, workDir: implementingTree }, [], fixture.seedEnv)
			await waitForText(terminal, PROMPT_READY, { full: false })
			terminal.submit(`Implement ${snapshotPath}`)
			await waitForText(terminal, "Continuing the saved attribution plan.")
			const ledgerDir = join(fixture.agentDir, "work-attribution")
			const requests = readLedger(ledgerDir).filter((record) => record.type === "request")
			expect(new Set(requests.map((record) => record.sessionId)).size).toBe(2)
			expect(new Set(requests.map((record) => record.workId))).toEqual(new Set([workId]))
			const summary = await waitForSummary(fixture.agentDir, workId, { sessions: 2, requests: 2, plans: 1 })
			expect(summary.workId).toBe(workId)
			expect(new Set(summary.sessions)).toEqual(new Set(requests.map((record) => record.sessionId)))
			expect(summary.plans).toContainEqual(expect.objectContaining({ path: planPath, snapshotPath }))
			for (const request of requests)
				expect(
					summary.requests.some(
						(item: { requestId: string; sessionId: string }) =>
							item.requestId === request.requestId && item.sessionId === request.sessionId,
					),
				).toBe(true)
			trace.step("the retained plan links both sessions after deleting the planning worktree")
		},
	)
})

test("a fresh session recovers an external worktree commit after a Git timeout without console noise", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "work-attribution-manual-commit",
			models,
			exitMarker: "WRITING_SESSION_EXITED",
			seedHome(home, cwd) {
				const primary = join(home, "primary-repo")
				execFileSync("git", ["init", primary])
				const git = (...args: string[]) => execFileSync("git", ["-C", primary, ...args])
				git("config", "user.name", "Attribution Test")
				git("config", "user.email", "attribution@example.invalid")
				git("config", "commit.gpgSign", "false")
				git("commit", "--allow-empty", "-m", "Baseline")
				git("worktree", "add", "-b", "external", cwd)
			},
			responses: [
				{
					toolCalls: [
						{
							function: {
								name: "write",
								arguments: JSON.stringify({ path: "manual.txt", content: "agent contribution\n" }),
							},
						},
					],
				},
				{ stream: ["The file is ready for your manual commit."] },
				{ stream: ["This is a fresh session after the manual commit."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Write manual.txt without committing it.")
			await waitForText(terminal, "The file is ready for your manual commit.")
			expect(readFileSync(join(fixture.workDir, "manual.txt"), "utf8")).toBe("agent contribution\n")
			const ledgerDir = join(fixture.agentDir, "work-attribution")
			const original = readLedger(ledgerDir).find((record) => record.type === "request")
			expect(original).toBeDefined()
			terminal.submit("/quit")
			await waitForText(terminal, "WRITING_SESSION_EXITED", { full: false })
			execFileSync("git", ["add", "manual.txt"], { cwd: fixture.workDir })
			execFileSync("git", ["commit", "-m", "User commits the agent contribution"], { cwd: fixture.workDir })
			const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.workDir, encoding: "utf8" }).trim()
			trace.step("agent wrote the file; user committed it after Kimchi exited")
			const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
			const bin = join(fixture.homeDir, "bin")
			mkdirSync(bin)
			const marker = join(fixture.homeDir, "git-timeout")
			writeFileSync(
				join(bin, "git"),
				`#!/bin/sh\nif [ "$3" = "ls-tree" ] && [ ! -f '${marker}' ]; then\n  touch '${marker}'\n  exec sleep 10\nfi\nexec '${realGit}' "$@"\n`,
				{ mode: 0o755 },
			)
			launchKimchi(
				terminal,
				fixture,
				[],
				{ ...fixture.seedEnv, PATH: `${bin}:${process.env.PATH}`, NODE_DEBUG: "" },
				{ exitMarker: "INTERRUPTED_SCAN_EXITED" },
			)
			const deadline = Date.now() + 10_000
			while (!existsSync(marker) && Date.now() < deadline) await sleep(50)
			expect(existsSync(marker)).toBe(true)
			const scanDeadline = Date.now() + 10_000
			while ((await check(ledgerDir)) && Date.now() < scanDeadline) await sleep(50)
			expect(await check(ledgerDir)).toBe(false)
			expect(readLedger(ledgerDir).filter((record) => record.type === "commit")).toEqual([])
			expect(fullText(terminal)).not.toContain("Could not reconcile repository")
			expect(fullText(terminal)).not.toContain("SIGTERM")
			trace.step("Git timed out; no partial attribution or raw error appeared in the terminal")
			terminal.submit("/quit")
			await waitForText(terminal, "INTERRUPTED_SCAN_EXITED", { full: false })
			launchKimchi(terminal, fixture, [], fixture.seedEnv)
			await waitForText(terminal, PROMPT_READY, { full: false })
			terminal.submit("Confirm this is a fresh session.")
			await waitForText(terminal, "This is a fresh session after the manual commit.")
			const originalSummary = await waitForSummary(fixture.agentDir, original.workId, { commits: 1, requests: 2 })
			const records = readLedger(ledgerDir)
			const contribution = records.find((record) => record.type === "commit" && record.sha === sha)
			expect(contribution).toMatchObject({
				source: "native-file-transition",
				paths: ["manual.txt"],
				sessionId: original.sessionId,
				workId: original.workId,
				repository: realpathSync(join(fixture.homeDir, "primary-repo", ".git")),
				worktree: realpathSync(fixture.workDir),
			})
			const requestId = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.at(-1)?.headers["x-request-id"]
			const fresh = records.find((record) => record.type === "request" && record.requestId === requestId)
			expect(fresh).toBeDefined()
			expect(fresh.sessionId).not.toBe(original.sessionId)
			expect(fresh.workId).not.toBe(original.workId)
			const freshSummary = await waitForSummary(fixture.agentDir, fresh.workId, { requests: 1 })
			expect(originalSummary.commits[0]).toMatchObject({ sha, sessionId: original.sessionId, paths: ["manual.txt"] })
			expect(originalSummary.requests.some((item: { requestId: string }) => item.requestId === fresh.requestId)).toBe(
				false,
			)
			expect(freshSummary.commits).toEqual([])
			expect(freshSummary.requests.some((item: { requestId: string }) => item.requestId === original.requestId)).toBe(
				false,
			)
			trace.step("original work summary owns the manual commit; fresh work has its own summary")
		},
	)
})

test("a skill-written ADR continues in a fresh session, and starting new work opts out", async ({ terminal }) => {
	let releaseImplementation = () => {}
	const held = new Promise<void>((release) => {
		releaseImplementation = release
	})
	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "work-attribution-skill-plan",
				gitInit: true,
				models,
				exitMarker: "ADR_PLANNER_EXITED",
				seedHome(_home, cwd) {
					const git = (...args: string[]) => execFileSync("git", args, { cwd })
					git("config", "user.name", "Attribution Test")
					git("config", "user.email", "attribution@example.invalid")
					git("config", "commit.gpgSign", "false")
					git("branch", "-M", "trunk")
					git("commit", "--allow-empty", "-m", "ADR baseline")
					git("update-ref", "refs/remotes/origin/trunk", "HEAD")
					git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
					git("checkout", "-b", "feature")
				},
				responses: [
					{
						toolCalls: [
							{
								function: {
									name: "write",
									arguments: JSON.stringify({ path: "docs/adr/greeting.md", content: "# Add a greeting\n" }),
								},
							},
						],
					},
					{ stream: ["The design is saved as an ADR."] },
					{ holdUntil: held, stream: ["Implementing the saved design."] },
					{ stream: ["This request belongs to separate work."] },
				],
			},
			async (fixture, trace) => {
				terminal.submit("Save the design to docs/adr/greeting.md using the write tool.")
				await waitForText(terminal, "The design is saved as an ADR.")
				const ledgerDir = join(fixture.agentDir, "work-attribution")
				const original = readLedger(ledgerDir).find((record) => record.type === "request")
				expect(readFileSync(join(fixture.workDir, "docs/adr/greeting.md"), "utf8")).toBe("# Add a greeting\n")
				expect(readLedger(ledgerDir).filter((record) => record.type === "plan")).toEqual([])
				terminal.submit("/quit")
				await waitForText(terminal, "ADR_PLANNER_EXITED")
				launchKimchi(terminal, fixture, [], fixture.seedEnv, { exitMarker: "ADR_IMPLEMENTER_EXITED" })
				await waitForText(terminal, PROMPT_READY, { full: false })
				const before = fixture.fake.requests.filter((request) =>
					request.url.startsWith("/openai/v1/chat/completions"),
				).length
				terminal.submit("Implement the saved design.")
				const deadline = Date.now() + 15_000
				while (
					fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")).length ===
						before &&
					Date.now() < deadline
				)
					await sleep(50)
				const sent = fixture.fake.requests
					.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
					.at(-1)
				const implementing = readLedger(ledgerDir).find((record) => record.requestId === sent?.headers["x-request-id"])
				expect(implementing).toBeDefined()
				expect(implementing.workId).toBe(original.workId)
				expect(implementing.sessionId).not.toBe(original.sessionId)
				trace.step("fresh session without a plan path adopts the ADR work before its held first response")
				releaseImplementation()
				await waitForText(terminal, "Implementing the saved design.")
				terminal.submit("/quit")
				await waitForText(terminal, "ADR_IMPLEMENTER_EXITED")
				launchKimchi(terminal, fixture, [], fixture.seedEnv)
				await waitForText(terminal, PROMPT_READY, { full: false })
				terminal.submit("/work new")
				await waitForText(terminal, "Work ID:", { full: false })
				terminal.submit("Do unrelated work in this same branch.")
				await waitForText(terminal, "This request belongs to separate work.")
				const separateId = fixture.fake.requests
					.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
					.at(-1)?.headers["x-request-id"]
				const separate = readLedger(ledgerDir).find((record) => record.requestId === separateId)
				expect(separate.workId).not.toBe(original.workId)
				const summary = await waitForSummary(fixture.agentDir, original.workId, { sessions: 2, requests: 3 })
				expect(summary.requests.some((request: { requestId: string }) => request.requestId === separateId)).toBe(false)
				expect(summary.fileTransitions).toContainEqual(
					expect.objectContaining({ path: "docs/adr/greeting.md", requestId: original.requestId }),
				)
				expect(summary.continuations).toContainEqual(
					expect.objectContaining({
						sessionId: implementing.sessionId,
						source: "recent-branch",
						evidence: expect.objectContaining({ branch: "feature" }),
					}),
				)
				trace.step("explicit new work remains separate despite the recent ADR on this branch")
			},
		)
	} finally {
		releaseImplementation()
	}
})
