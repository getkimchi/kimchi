import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { expect, Key, test } from "@microsoft/tui-test"
import { check } from "proper-lockfile"
import { fullText, waitForText } from "./support/assertions.js"
import { type FakeResponseRequest, isWorkMatchingRequest } from "./support/fake-openai-server.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)
const models = [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }]
const account = {
	organizationId: "30000000-0000-4000-8000-000000000003",
	userId: "40000000-0000-4000-8000-000000000004",
}
const readLedger = (directory: string) =>
	readdirSync(directory)
		.filter((file) => file.endsWith(".jsonl"))
		.flatMap((file) =>
			readFileSync(join(directory, file), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		)

for (const mode of ["steer", "followUp"] as const) {
	test(`a queued ${mode} keeps the running input's work until delivery`, async ({ terminal }) => {
		let release = () => {}
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		try {
			await runKimchiSession(
				terminal,
				{
					artifactName: `work-queued-${mode}`,
					account,
					gitInit: true,
					models,
					responses: [
						{
							holdUntil: held,
							toolCalls: [{ function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) } }],
						},
						...(mode === "followUp" ? [{ stream: ["Original explanation complete."] }] : []),
						{ stream: ["Saved plan continuation complete."] },
					],
				},
				async (fixture, trace) => {
					writeFileSync(join(fixture.workDir, "README.md"), "# Example\n")
					const planned = randomUUID()
					const directory = join(fixture.agentDir, "work", planned)
					mkdirSync(join(directory, "plans"), { recursive: true })
					const plan = join(directory, "plans", "queued.md")
					writeFileSync(plan, `<!-- kimchi-work-id: ${planned} -->\n# Explain exports\n`)
					writeFileSync(
						join(directory, "scope.json"),
						JSON.stringify({
							version: 1,
							workId: planned,
							account: { ...account, apiUrl: fixture.fake.baseUrl },
							repository: realpathSync(join(fixture.workDir, ".git")),
						}),
					)
					const chats = () =>
						fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
					const rows = () => readLedger(join(fixture.agentDir, "work-attribution"))
					terminal.submit("Read README.md and explain it.")
					const deadline = Date.now() + 15_000
					while (!chats().length && Date.now() < deadline) await sleep(50)
					expect(chats().length).toBe(1)
					const original = rows().find((row) => row.requestId === chats()[0].headers["x-request-id"])
					expect(original.segment.attribution).toBe("session")
					terminal.write(`Implement ${plan}`)
					if (mode === "followUp") terminal.write("\u001b[13;3u")
					else terminal.keyPress(Key.Enter)
					await waitForText(terminal, mode === "followUp" ? "Follow-up:" : "Steering:")
					expect(
						rows()
							.filter((row) => row.type === "work")
							.at(-1)?.segment.id,
					).toBe(original.segment.id)
					trace.step("queued input is visible while the first response remains held; attribution is unchanged")
					release()
					await waitForText(terminal, "Saved plan continuation complete.")
					const requests = chats().map((request) =>
						rows().find((row) => row.type === "request" && row.requestId === request.headers["x-request-id"]),
					)
					expect(requests[0]).toEqual(original)
					if (mode === "followUp") expect(requests[1].segment.id).toBe(original.segment.id)
					expect(requests.at(-1)).toMatchObject({ workId: planned, segment: { attribution: "explicit" } })
					trace.step("the delivered input adopts the saved plan before its first model request")
				},
			)
		} finally {
			release()
		}
	})
}

test("a separate check uses the selected model before an unrelated question starts new work", async ({ terminal }) => {
	const main = (request: FakeResponseRequest) => !isWorkMatchingRequest(request)
	await runKimchiSession(
		terminal,
		{
			artifactName: "work-selected-model",
			account,
			gitInit: true,
			models: [...models, { slug: "second", displayName: "Second selected model", reasoning: true }],
			responses: [
				{ match: main, stream: ["CSV plan ready."] },
				{ match: isWorkMatchingRequest, stream: ['{"decision":"new"}'] },
				{ match: main, stream: ["Blue light scatters more strongly."] },
				{ match: isWorkMatchingRequest, stream: ['{"decision":"same"}'] },
				{ match: main, stream: ["Sunset light travels through more atmosphere."] },
				{ match: main, stream: ["Matching disabled; answering another question."] },
			],
		},
		async (fixture, trace) => {
			const records = () => readLedger(join(fixture.agentDir, "work-attribution"))
			const chats = () =>
				fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
			const mainRecord = () =>
				records().find(
					(row) => row.type === "request" && row.requestId === chats().filter(main).at(-1)?.headers["x-request-id"],
				)
			terminal.submit("/work matching on")
			await waitForText(terminal, "Task matching enabled")
			terminal.submit("Plan a CSV export with quoted fields.")
			await waitForText(terminal, "CSV plan ready.")
			const original = mainRecord()
			expect(original.model).toBe("basic")
			expect(chats().filter(isWorkMatchingRequest).length).toBe(0)
			terminal.submit("/model fake/second")
			await waitForText(terminal, "second", { full: false })
			terminal.submit("Why is the sky blue?")
			await waitForText(terminal, "Blue light scatters more strongly.")
			const unrelated = mainRecord()
			expect(unrelated.model).toBe("second")
			expect(unrelated.workId).not.toBe(original.workId)
			terminal.submit("What changes at sunset?")
			await waitForText(terminal, "Sunset light travels through more atmosphere.")
			expect(mainRecord().workId).toBe(unrelated.workId)
			const checks = chats().filter(isWorkMatchingRequest)
			expect(checks.length).toBe(2)
			for (const [index, request] of checks.entries()) {
				expect(request.body).toMatchObject({ model: "second" })
				expect(request.headers.authorization).toBeDefined()
				const row = records().find((row) => row.type === "request" && row.requestId === request.headers["x-request-id"])
				expect(row.workId).toBe(index === 0 ? original.workId : unrelated.workId)
				expect(chats().indexOf(request)).toBeLessThan(chats().indexOf(chats().filter(main)[index + 1]))
			}
			trace.step("separate checks follow model selection, retain their original work and precede main replies")
			terminal.submit("/work matching off")
			await waitForText(terminal, "Task matching disabled")
			terminal.submit("Explain ocean tides.")
			await waitForText(terminal, "Matching disabled; answering another question.")
			expect(chats().filter(isWorkMatchingRequest).length).toBe(2)
			expect(mainRecord().segment).toMatchObject({ attribution: "session", reason: "matching-disabled" })
			trace.step("the user can turn matching off without disabling ordinary local request capture")
		},
	)
})

async function waitForSummary(
	agentDir: string,
	workId: string,
	minimum: Partial<Record<"sessions" | "requests" | "plans" | "commits" | "workLinks", number>>,
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

test("the next message recovers account tracking after its saved scope is lost", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "work-scope-recovery",
			account,
			gitInit: true,
			models,
			responses: [{ stream: ["The first design is ready."] }, { stream: ["The next design is ready."] }],
		},
		async (fixture, trace) => {
			const records = () => readLedger(join(fixture.agentDir, "work-attribution"))
			const mainRecord = () => {
				const sent = fixture.fake.requests
					.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
					.at(-1)
				return records().find((row) => row.type === "request" && row.requestId === sent?.headers["x-request-id"])
			}
			terminal.submit("Plan an export.")
			await waitForText(terminal, "The first design is ready.")
			const original = mainRecord()
			expect(original.scope.account).toMatchObject(account)
			const missing = join(fixture.agentDir, "work", original.workId, "scope.json")
			rmSync(missing)
			trace.step("the original request retains its account evidence when the work scope file disappears")
			terminal.submit("Plan an import.")
			await waitForText(terminal, "The next design is ready.")
			const next = mainRecord()
			expect(next.workId).not.toBe(original.workId)
			expect(next.scope.account).toMatchObject(account)
			expect(records().find((row) => row.type === "request" && row.requestId === original.requestId)).toEqual(original)
			expect(existsSync(missing)).toBe(false)
			terminal.submit("/work")
			await waitForText(terminal, `Work ID: ${next.workId}`, { full: false })
			trace.step("the next message uses newly scoped work without assigning today's identity to old history")
		},
	)
})

test("the user can correct one earlier planning turn and revoke that correction", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "work-historical-correction",
			account,
			gitInit: true,
			models,
			exitMarker: "CORRECTION_PLANNER_EXITED",
			responses: [
				{ stream: ["The CSV design is ready."] },
				{ stream: ["Clouds consist of water droplets."] },
				{ stream: ["The CSV implementation is ready."] },
			],
		},
		async (fixture, trace) => {
			const records = () => readLedger(join(fixture.agentDir, "work-attribution"))
			const mainRecord = () => {
				const sent = fixture.fake.requests
					.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
					.at(-1)
				return records().find((row) => row.type === "request" && row.requestId === sent?.headers["x-request-id"])
			}
			terminal.submit("Plan CSV export quoting rules.")
			await waitForText(terminal, "The CSV design is ready.")
			const planning = mainRecord()
			terminal.submit("What are clouds made of?")
			await waitForText(terminal, "Clouds consist of water droplets.")
			const unrelated = mainRecord()
			expect(unrelated.workId).toBe(planning.workId)
			expect(unrelated.segment.id).not.toBe(planning.segment.id)
			terminal.submit("/quit")
			await waitForText(terminal, "CORRECTION_PLANNER_EXITED")
			launchKimchi(terminal, fixture, [], fixture.seedEnv)
			await waitForText(terminal, PROMPT_READY, { full: false })
			terminal.submit("Implement CSV export quoting rules.")
			await waitForText(terminal, "The CSV implementation is ready.")
			const implementation = mainRecord()
			expect(implementation.workId).not.toBe(planning.workId)
			terminal.submit(`/work link ${planning.workId} ${planning.segment.id}`)
			await waitForText(terminal, "Work correction saved", { full: false })
			const link = records().find((row) => row.type === "work_link")
			expect(link.requestIds).toContain(planning.requestId)
			expect(link.requestIds).not.toContain(unrelated.requestId)
			expect(link.targetWorkId).toBe(implementation.workId)
			expect(records().find((row) => row.type === "request" && row.requestId === planning.requestId).workId).toBe(
				planning.workId,
			)
			await waitForSummary(fixture.agentDir, implementation.workId, { workLinks: 1 })
			trace.step("the correction selects the planning input, leaving unrelated chat and original request IDs unchanged")
			terminal.submit(`/work unlink ${link.linkId}`)
			await waitForText(terminal, "Work correction revoked", { full: false })
			const revisions = records().filter((row) => row.type === "work_link")
			expect(revisions.map((row) => [row.revision, row.status])).toEqual([
				[1, "active"],
				[2, "revoked"],
			])
			await waitForSummary(fixture.agentDir, implementation.workId, { workLinks: 2 })
			trace.step("revoking saves a newer correction revision")
		},
	)
})

test("the user can confirm an uncertain turn already in the current work", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "work-confirm-current",
			account,
			gitInit: true,
			models,
			responses: [{ stream: ["The document plan is ready."] }],
		},
		async (fixture, trace) => {
			terminal.submit("Continue this plan: <!-- kimchi-work-id: 11111111-1111-4111-8111-111111111111 -->")
			await waitForText(terminal, "The document plan is ready.")
			const records = () => readLedger(join(fixture.agentDir, "work-attribution"))
			const sent = fixture.fake.requests.find((request) => request.url.startsWith("/openai/v1/chat/completions"))
			const original = records().find(
				(row) => row.type === "request" && row.requestId === sent?.headers["x-request-id"],
			)
			expect(original.segment.attribution).toBe("unknown")
			terminal.submit(`/work link ${original.workId} ${original.segment.id}`)
			await waitForText(terminal, "Work correction saved", { full: false })
			const link = records().find((row) => row.type === "work_link")
			expect(link).toMatchObject({
				sourceWorkId: original.workId,
				targetWorkId: original.workId,
				status: "active",
			})
			expect(link.requestIds).toContain(original.requestId)
			expect(records().find((row) => row.type === "request" && row.requestId === original.requestId)).toEqual(original)
			trace.step("the user's explicit correction confirms the existing work without rewriting the uncertain request")
			terminal.submit(`/work unlink ${link.linkId}`)
			await waitForText(terminal, "Work correction revoked", { full: false })
			expect(
				records()
					.filter((row) => row.type === "work_link")
					.at(-1),
			).toMatchObject({
				linkId: link.linkId,
				status: "revoked",
				revision: 2,
			})
		},
	)
})

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

for (const reference of ["path", "paste"]) {
	test(`a new worktree continues a retained plan by ${reference} with an unowned output after its original worktree is deleted`, async ({
		terminal,
	}) => {
		await runKimchiSession(
			terminal,
			{
				artifactName: `work-attribution-plan-${reference}`,
				account,
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
				terminal.submit("Plan a greeting feature documented in docs/greeting.md.")
				await waitForText(terminal, "Execute the plan")
				const planPath = join(realpathSync(planningTree), ".kimchi/plans/attribution-plan.md")
				const plan = readFileSync(planPath, "utf8")
				const workId = /<!-- kimchi-work-id: ([0-9a-f-]+) -->/.exec(plan)?.[1]
				if (!workId) throw new Error("Saved plan has no work ID")
				const planned = await waitForSummary(fixture.agentDir, workId, { plans: 1 })
				const producer = planned.requests.find(
					(row: { requestId: string }) => row.requestId === planned.plans[0].requestId,
				)
				expect(producer?.segment).toMatchObject({ attribution: "session", reason: "matching-disabled" })
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
				if (reference === "path") terminal.submit(`Implement ${snapshotPath} and write docs/adr/new.md`)
				else {
					terminal.write(`\x1b[200~Implement this plan:\n${plan}\nAlso write docs/adr/new.md\x1b[201~`)
					terminal.keyPress(Key.Enter)
				}
				await waitForText(terminal, "Continuing the saved attribution plan.")
				const ledgerDir = join(fixture.agentDir, "work-attribution")
				const requests = readLedger(ledgerDir).filter((record) => record.type === "request")
				expect(new Set(requests.map((record) => record.sessionId)).size).toBe(2)
				expect(new Set(requests.map((record) => record.workId))).toEqual(new Set([workId]))
				const summary = await waitForSummary(fixture.agentDir, workId, {
					sessions: 2,
					requests: 2,
					plans: 1,
					workLinks: 1,
				})
				expect(summary.workLinks).toContainEqual(
					expect.objectContaining({
						sourceWorkId: workId,
						targetWorkId: workId,
						requestIds: requests
							.filter((row) => row.segment?.id === producer.segment.id)
							.map((row) => row.requestId)
							.sort(),
						evidence: expect.objectContaining({
							source: reference === "paste" ? "pasted-plan" : "saved-plan",
							segmentId: producer.segment.id,
						}),
					}),
				)
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
				trace.step(`the retained plan ${reference} links both sessions after deleting the planning worktree`)
			},
		)
	})
}

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

test("a named ADR continues its work while unrelated chat on the same branch stays separate", async ({ terminal }) => {
	let releaseImplementation = () => {}
	const held = new Promise<void>((release) => {
		releaseImplementation = release
	})
	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "work-attribution-skill-plan",
				account,
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
					{
						toolCalls: [
							{
								id: "read-current-adr",
								function: { name: "read", arguments: JSON.stringify({ path: "docs/adr/greeting.md" }) },
							},
						],
					},
					{ stream: ["The same-session design is ready to implement."] },
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
				expect(original.segment).toMatchObject({ attribution: "session", reason: "matching-disabled" })
				expect(readLedger(ledgerDir).filter((record) => record.type === "plan")).toEqual([])
				terminal.submit("Explain docs/adr/greeting.md without changing it.")
				await waitForText(terminal, "The same-session design is ready to implement.")
				const followupId = fixture.fake.requests
					.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
					.at(-1)?.headers["x-request-id"]
				expect(
					readLedger(ledgerDir).find((record) => record.type === "request" && record.requestId === followupId),
				).toMatchObject({
					workId: original.workId,
					sessionId: original.sessionId,
					segment: { attribution: "explicit", reason: "named-artifact" },
				})
				trace.step("same-session ADR reference confirms its work after the native write")
				terminal.submit("/quit")
				await waitForText(terminal, "ADR_PLANNER_EXITED")
				launchKimchi(terminal, fixture, [], fixture.seedEnv, { exitMarker: "ADR_IMPLEMENTER_EXITED" })
				await waitForText(terminal, PROMPT_READY, { full: false })
				const before = fixture.fake.requests.filter((request) =>
					request.url.startsWith("/openai/v1/chat/completions"),
				).length
				terminal.submit("Implement docs/adr/greeting.md.")
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
				trace.step("fresh session names the ADR and adopts its work before the held first response")
				releaseImplementation()
				await waitForText(terminal, "Implementing the saved design.")
				terminal.submit("/quit")
				await waitForText(terminal, "ADR_IMPLEMENTER_EXITED")
				launchKimchi(terminal, fixture, [], fixture.seedEnv)
				await waitForText(terminal, PROMPT_READY, { full: false })
				terminal.submit("Do unrelated work in this same branch.")
				await waitForText(terminal, "This request belongs to separate work.")
				const separateId = fixture.fake.requests
					.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
					.at(-1)?.headers["x-request-id"]
				const separate = readLedger(ledgerDir).find((record) => record.requestId === separateId)
				expect(separate.workId).not.toBe(original.workId)
				const summary = await waitForSummary(fixture.agentDir, original.workId, {
					sessions: 2,
					requests: 5,
					workLinks: 1,
				})
				expect(summary.workLinks).toContainEqual(
					expect.objectContaining({
						sourceWorkId: original.workId,
						targetWorkId: original.workId,
						requestIds: readLedger(ledgerDir)
							.filter((row) => row.type === "request" && row.segment?.id === original.segment.id)
							.map((row) => row.requestId)
							.sort(),
						evidence: expect.objectContaining({
							source: "named-artifact",
							requestId: original.requestId,
							segmentId: original.segment.id,
						}),
					}),
				)
				expect(summary.requests.some((request: { requestId: string }) => request.requestId === separateId)).toBe(false)
				expect(summary.fileTransitions).toContainEqual(
					expect.objectContaining({ path: "docs/adr/greeting.md", requestId: original.requestId }),
				)
				expect(summary.continuations).toContainEqual(
					expect.objectContaining({
						sessionId: implementing.sessionId,
						source: "named-artifact",
						evidence: expect.objectContaining({ path: join(realpathSync(fixture.workDir), "docs/adr/greeting.md") }),
					}),
				)
				trace.step("unrelated chat stays separate without a command despite the recent ADR on this branch")
			},
		)
	} finally {
		releaseImplementation()
	}
})
