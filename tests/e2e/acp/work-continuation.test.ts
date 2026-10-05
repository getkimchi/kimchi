import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { isWorkMatchingRequest } from "../tui/support/fake-openai-server.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

let fixture: AcpFixture | undefined
let releaseReply = () => {}
const account = {
	organizationId: "30000000-0000-4000-8000-000000000003",
	userId: "40000000-0000-4000-8000-000000000004",
}

afterEach(async () => {
	releaseReply()
	await fixture?.stop()
})

it("links a plan pasted into Studio before dispatching its first request", async () => {
	const held = new Promise<void>((resolve) => {
		releaseReply = resolve
	})
	const active = await startAcpFixture({
		artifactName: "work-pasted-plan",
		account,
		responses: [{ holdUntil: held, stream: ["Continuing the pasted plan."] }],
	})
	fixture = active
	const workId = randomUUID()
	const content = `<!-- kimchi-work-id: ${workId} -->\n# Export report\nWrite docs/new.md and src/export.ts.\n`
	const agentDir = join(active.homeDir, ".config", "kimchi", "harness")
	const planDir = join(agentDir, "work", workId, "plans")
	mkdirSync(planDir, { recursive: true })
	const hash = createHash("sha256").update(content).digest("hex")
	const path = join(planDir, `export-${hash}.md`)
	writeFileSync(path, content)
	execFileSync("git", ["init", "-q", active.workDir])
	writeFileSync(
		join(agentDir, "work", workId, "scope.json"),
		JSON.stringify({
			version: 1,
			workId,
			account: { ...account, apiUrl: active.fake.baseUrl },
			repository: realpathSync(join(active.workDir, ".git")),
		}),
	)
	const session = await newSession(active, active.workDir)
	const running = prompt(active, session, `Implement this plan:\n\n\`\`\`markdown\n${content}\`\`\``)
	try {
		const chats = () => active.fake.requests.filter((row) => row.url.startsWith("/openai/v1/chat/completions"))
		await expect.poll(() => chats().length, { timeout: 10_000 }).toBe(1)
		const requestId = chats()[0].headers["x-request-id"]
		const ledgerDir = join(agentDir, "work-attribution")
		const records = readdirSync(ledgerDir)
			.filter((name) => name.endsWith(".jsonl"))
			.flatMap((name) => readFileSync(join(ledgerDir, name), "utf8").trim().split("\n").filter(Boolean))
			.map((line) => JSON.parse(line))
		expect(records).toContainEqual(expect.objectContaining({ type: "request", requestId, workId }))
		expect(records).toContainEqual(
			expect.objectContaining({
				type: "work",
				workId,
				continuation: {
					source: "pasted-plan",
					evidence: expect.objectContaining({
						path,
						contentHash: hash,
						segmentId: expect.any(String),
						account: { ...account, apiUrl: active.fake.baseUrl },
						repository: realpathSync(join(active.workDir, ".git")),
					}),
				},
			}),
		)
	} finally {
		releaseReply()
		await running
	}
})

it("keeps unrelated Studio chat separate until a saved ADR is named, without moving earlier requests", async () => {
	const held = new Promise<void>((resolve) => {
		releaseReply = resolve
	})
	const active = await startAcpFixture({
		artifactName: "work-continuation",
		account,
		extraArgs: ["--yolo"],
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
			{ stream: ["The ADR is saved."] },
			{
				toolCalls: [
					{
						id: "read-current-adr",
						function: { name: "read", arguments: JSON.stringify({ path: "docs/adr/greeting.md" }) },
					},
				],
			},
			{ stream: ["The current design adds a greeting."] },
			{ stream: ["A closure keeps access to its surrounding scope."] },
			{ holdUntil: held, stream: ["Continuing the named ADR."] },
		],
	})
	fixture = active
	const cwd = active.workDir
	const git = (...args: string[]) => execFileSync("git", args, { cwd })
	git("init", "--initial-branch=trunk")
	git("config", "user.name", "Continuation Test")
	git("config", "user.email", "continuation@example.invalid")
	git("config", "commit.gpgSign", "false")
	git("commit", "--allow-empty", "-m", "Fixture baseline")
	git("update-ref", "refs/remotes/origin/trunk", "HEAD")
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
	git("checkout", "-b", "feature")
	const ledgerDir = join(active.homeDir, ".config", "kimchi", "harness", "work-attribution")
	const records = () =>
		readdirSync(ledgerDir)
			.filter((name) => name.endsWith(".jsonl"))
			.flatMap((name) => readFileSync(join(ledgerDir, name), "utf8").trim().split("\n").filter(Boolean))
			.map((line) => JSON.parse(line))
	const chats = () => active.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
	const lastRequest = () => {
		const requestId = chats().at(-1)?.headers["x-request-id"]
		expect(requestId).toBeDefined()
		const row = records().find((record) => record.type === "request" && record.requestId === requestId)
		expect(row).toBeDefined()
		return row
	}

	const planner = await newSession(active, cwd)
	expect((await prompt(active, planner, "Write the design in docs/adr/greeting.md.")).stopReason).toBe("end_turn")
	expect(readFileSync(join(cwd, "docs/adr/greeting.md"), "utf8")).toBe("# Add a greeting\n")
	const original = lastRequest()
	expect((await prompt(active, planner, "Explain docs/adr/greeting.md without changing it.")).stopReason).toBe(
		"end_turn",
	)
	expect(lastRequest()).toMatchObject({
		sessionId: original.sessionId,
		workId: original.workId,
		segment: { attribution: "explicit", reason: "named-artifact" },
	})
	expect(records()).toContainEqual(
		expect.objectContaining({
			type: "work",
			workId: original.workId,
			sessionId: original.sessionId,
			continuation: {
				source: "named-artifact",
				evidence: expect.objectContaining({
					requestId: chats()[0].headers["x-request-id"],
					segmentId: lastRequest().segment.id,
					account: { ...account, apiUrl: active.fake.baseUrl },
				}),
			},
		}),
	)
	const fresh = await newSession(active, cwd)
	expect((await prompt(active, fresh, "Explain what a closure is.")).stopReason).toBe("end_turn")
	const unrelated = lastRequest()
	expect(unrelated.sessionId).not.toBe(original.sessionId)
	expect(unrelated.workId).not.toBe(original.workId)

	const before = chats().length
	const continuing = prompt(active, fresh, "Implement docs/adr/greeting.md.")
	try {
		await expect.poll(() => chats().length, { timeout: 10_000 }).toBeGreaterThan(before)
		expect(lastRequest()).toMatchObject({ sessionId: unrelated.sessionId, workId: original.workId })
		expect(records().find((row) => row.requestId === unrelated.requestId)).toMatchObject({
			workId: unrelated.workId,
		})
	} finally {
		releaseReply()
		await continuing
	}
})

it("uses separate calls to the selected model to continue and split Studio work before dispatch", async () => {
	// This checks ACP ordering and storage. Scripted decisions are not model-accuracy evidence.
	const judge = isWorkMatchingRequest
	const main = (request: Parameters<typeof judge>[0]) => !judge(request)
	const held = new Promise<void>((resolve) => {
		releaseReply = resolve
	})
	const active = await startAcpFixture({
		artifactName: "work-semantic-continuation",
		settings: { workSemanticMatching: true, modelRoles: { judge: ["unavailable/unused"] } },
		account,
		models: [{ slug: "basic", displayName: "Selected model", contextWindow: 64_000 }],
		responses: [
			{ match: main, stream: ["Plan: quote comma-separated fields and escape double quotes."] },
			{ match: judge, stream: [JSON.stringify({ decision: "specific" })] },
			{ match: judge, stream: [JSON.stringify({ decision: "match" })] },
			{ match: main, holdUntil: held, stream: ["Implementing the planned export."] },
			{ match: judge, stream: [JSON.stringify({ decision: "new" })] },
			{ match: main, stream: ["The Moon's phases follow its position relative to Earth and the Sun."] },
		],
	})
	fixture = active
	const agentDir = join(active.homeDir, ".config", "kimchi", "harness")
	execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: active.workDir })
	const records = () =>
		readdirSync(join(agentDir, "work-attribution"))
			.filter((name) => name.endsWith(".jsonl"))
			.flatMap((name) =>
				readFileSync(join(agentDir, "work-attribution", name), "utf8")
					.trim()
					.split("\n")
					.filter(Boolean),
			)
			.map((line) => JSON.parse(line))
	const mainRequests = () =>
		active.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions") && main(request))
	const requestRecord = (index: number) => {
		const requestId = mainRequests()[index]?.headers["x-request-id"]
		expect(requestId).toBeDefined()
		const record = records().find((row) => row.type === "request" && row.requestId === requestId)
		expect(record).toBeDefined()
		return record
	}
	const planningText = "Plan a CSV download with quoted fields and double-quote escaping."
	const continuationText = "Implement the comma-separated download with escaped quotes from the earlier plan."
	const unrelatedText = "Explain the phases of the Moon."
	const planner = await newSession(active, active.workDir)
	await active.conn.extMethod("_kimchi.dev/set_session_title", { sessionId: planner, title: "ACP export planner" })
	expect((await prompt(active, planner, planningText)).stopReason).toBe("end_turn")
	expect(mainRequests()).toHaveLength(1)
	expect(active.fake.requests.filter(judge)).toHaveLength(0)
	const planned = requestRecord(0)
	expect(JSON.parse(readFileSync(join(agentDir, "work", planned.workId, "intent.json"), "utf8"))).toMatchObject({
		workId: planned.workId,
		summary: planningText,
	})
	const implementer = await newSession(active, active.workDir)
	await active.conn.extMethod("_kimchi.dev/set_session_title", {
		sessionId: implementer,
		title: "ACP export implementation",
	})
	const continuing = prompt(active, implementer, continuationText)
	try {
		await expect.poll(() => mainRequests().length, { timeout: 10_000 }).toBe(2)
		const implementation = requestRecord(1)
		expect(implementation.workId).toBe(planned.workId)
		expect(implementation.sessionId).not.toBe(planned.sessionId)
		const comparisons = active.fake.requests.filter(judge)
		expect(comparisons).toHaveLength(2)
		for (const comparison of comparisons)
			expect(active.fake.requests.indexOf(comparison)).toBeLessThan(active.fake.requests.indexOf(mainRequests()[1]))
		expect(records()).toContainEqual(
			expect.objectContaining({
				type: "work",
				workId: planned.workId,
				sessionId: implementation.sessionId,
				continuation: expect.objectContaining({
					source: "semantic",
					evidence: expect.objectContaining({ decision: "continue", model: "fake/basic" }),
				}),
			}),
		)
	} finally {
		releaseReply()
		expect((await continuing).stopReason).toBe("end_turn")
	}
	expect((await prompt(active, implementer, unrelatedText)).stopReason).toBe("end_turn")
	expect(mainRequests()).toHaveLength(3)
	const unrelated = requestRecord(2)
	expect(unrelated.workId).not.toBe(planned.workId)
	expect(unrelated.sessionId).toBe(requestRecord(1).sessionId)
	expect(requestRecord(0).workId).toBe(planned.workId)
	expect(requestRecord(1).workId).toBe(planned.workId)
	const judgeRequests = active.fake.requests.filter(judge)
	expect(judgeRequests).toHaveLength(3)
	const judgeInputs = judgeRequests.map((request) => {
		if (
			!request.body ||
			typeof request.body !== "object" ||
			!("messages" in request.body) ||
			!Array.isArray(request.body.messages)
		)
			throw new Error("Missing judge messages")
		return JSON.parse(request.body.messages.find((message) => message.role === "user").content)
	})
	const savedIntent = { workId: planned.workId, summary: planningText }
	expect(judgeInputs).toEqual([
		{ message: continuationText },
		{ current: null, candidates: [savedIntent], message: continuationText, selectedWorkId: planned.workId },
		{ current: savedIntent, candidates: [], message: unrelatedText },
	])
	expect(JSON.stringify(judgeRequests[0].body)).not.toContain(planned.workId)
	expect(JSON.stringify(judgeRequests[0].body)).not.toContain(planningText)
	for (const request of judgeRequests) {
		expect(request.headers.authorization).toBeDefined()
		expect(request.headers["x-request-id"]).toBeDefined()
		expect(records()).toContainEqual(
			expect.objectContaining({ type: "request", requestId: request.headers["x-request-id"], model: "basic" }),
		)
		expect(request.body).toMatchObject({ model: "basic" })
	}
	await expect
		.poll(() => {
			const summary = JSON.parse(readFileSync(join(agentDir, "work", planned.workId, "work.json"), "utf8"))
			return summary.requests.map((row: { requestId: string }) => row.requestId).sort()
		})
		.toEqual([planned.requestId, requestRecord(1).requestId, judgeRequests[2].headers["x-request-id"]].sort())
	await expect
		.poll(() => {
			const summary = JSON.parse(readFileSync(join(agentDir, "work", unrelated.workId, "work.json"), "utf8"))
			return summary.requests.map((row: { requestId: string }) => row.requestId)
		})
		.toEqual([unrelated.requestId])
	for (const workId of [planned.workId, unrelated.workId]) {
		const summary = readFileSync(join(agentDir, "work", workId, "work.json"), "utf8")
		for (const privateText of [planningText, continuationText, unrelatedText, "Decide whether a user's"])
			expect(summary).not.toContain(privateText)
	}
})
