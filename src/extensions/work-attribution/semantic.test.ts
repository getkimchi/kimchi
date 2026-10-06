import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type * as Settings from "../../config/settings.js"
import { readConfigSetting } from "../../config/settings.js"
import { savePlanMarkdown } from "../../shared/planning/plan-markdown.js"
import { createContext } from "../__mocks__/context.js"
import { createModel, createModelRegistry } from "../__mocks__/model-registry.js"
import * as redactionConfig from "../pii-redaction/config.js"
import { redactTextOrThrow } from "../pii-redaction/redactor.js"
import { getWorkId, setWorkId } from "../work-attribution.js"
import type * as WorkAccounts from "./scope.js"
import { classifyWorkIntent, loadWorkIntents, rememberWorkIntent, workIntentPath } from "./semantic.js"
import { flushWorkSummaries, readWorkRecords } from "./summary.js"

vi.mock("../pii-redaction/redactor.js", () => ({ redactTextOrThrow: vi.fn() }))
vi.mock("../../config/settings.js", async (original) => ({
	...(await original<typeof Settings>()),
	readConfigSetting: vi.fn(() => true),
}))
vi.mock("./scope.js", async (original) => ({
	...(await original<typeof WorkAccounts>()),
	captureWorkAccount: vi.fn(async () => ({
		account: {
			apiUrl: "https://account.example/api",
			organizationId: "30000000-0000-4000-8000-000000000003",
			userId: "40000000-0000-4000-8000-000000000004",
		},
		isCurrent: () => true,
	})),
}))
vi.mock("../orchestration/model-roles.js", () => ({
	getModelRoles: () => ({ judge: ["local/qwen"] }),
	normalizeRoleModels: (value: string[]) => value,
}))

const servers: Server[] = []
const roots: string[] = []
beforeEach(() => vi.mocked(readConfigSetting).mockReturnValue(true))
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.useRealTimers()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function provider(answer: string | string[], status = 200, headers: Record<string, string> = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-selected-model-")))
	roots.push(root)
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))
	const requests: { headers: Record<string, unknown>; body: string; persisted: boolean }[] = []
	const delays: number[] = []
	const server = createServer(async (request, response) => {
		let body = ""
		for await (const part of request) body += part
		requests.push({
			headers: request.headers,
			body,
			persisted: readWorkRecords(join(root, "agent")).some(
				(row) => row.type === "request" && row.requestId === request.headers["x-request-id"],
			),
		})
		const content = Array.isArray(answer) ? (answer[requests.length - 1] ?? "{}") : answer
		const delay = delays[requests.length - 1]
		if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
		response.writeHead(status, { "content-type": "text/event-stream", ...headers })
		response.end(
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n` +
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
		)
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address() as AddressInfo
	const model = {
		...createModel("chat", "selected"),
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		contextWindow: 8192,
	}
	const registry = createModelRegistry([model])
	const ctx = createContext({ cwd: root, model, modelRegistry: registry })
	return { model, requests, delays, registry, ctx, root }
}

const workId = "10000000-0000-4000-8000-000000000001"
const input = {
	current: null,
	candidates: [{ workId, summary: "Add CSV export with quoted fields." }],
	message: "Implement the comma-separated export.",
}

it("uses the selected model and normal auth with a durable ID per separate request", async () => {
	const server = await provider([JSON.stringify({ decision: "specific" }), JSON.stringify({ decision: "match" })])
	vi.mocked(server.registry.getApiKeyAndHeaders).mockResolvedValue({
		ok: true,
		apiKey: "selected-key",
		headers: { "X-Custom": "configured" },
	})
	expect(await classifyWorkIntent(server.ctx, input)).toEqual({ decision: "continue", workId, model: "selected/chat" })
	expect(server.registry.getApiKeyAndHeaders).toHaveBeenCalledExactlyOnceWith(server.ctx.model)
	expect(server.requests).toHaveLength(2)
	for (const request of server.requests) {
		expect(request.persisted).toBe(true)
		expect(request.headers.authorization).toBe("Bearer selected-key")
		expect(request.headers["x-custom"]).toBe("configured")
		expect(request.headers["x-session-id"]).toBe("test-session")
		expect(JSON.parse(request.body)).toMatchObject({ model: "chat" })
	}
	expect(new Set(server.requests.map((r) => r.headers["x-request-id"])).size).toBe(2)
	const overhead = readWorkRecords(join(server.root, "agent")).filter((row) => row.type === "request")
	expect(overhead).toHaveLength(2)
	expect(overhead.every((row) => row.purpose === "work-matching")).toBe(true)
	for (const row of overhead) expect(row.segment).toMatchObject({ attribution: "session", reason: "work-matching" })
})

it("does not authenticate or send private task history when matching is disabled", async () => {
	const server = await provider(JSON.stringify({ decision: "same" }))
	vi.mocked(readConfigSetting).mockReturnValue(false)
	expect(await classifyWorkIntent(server.ctx, input)).toMatchObject({ decision: "unknown" })
	expect(server.registry.getApiKeyAndHeaders).not.toHaveBeenCalled()
	expect(server.requests).toHaveLength(0)
})

it("cancels pending authentication when matching permission is revoked", async () => {
	const server = await provider(JSON.stringify({ decision: "same" }))
	let finish!: () => void
	vi.mocked(server.registry.getApiKeyAndHeaders).mockImplementationOnce(async () => {
		await new Promise<void>((resolve) => {
			finish = resolve
		})
		return { ok: true, apiKey: "selected-key", headers: {} }
	})
	const pending = classifyWorkIntent(server.ctx, input)
	await vi.waitFor(() => expect(finish).toBeDefined())
	vi.mocked(readConfigSetting).mockReturnValue(false)
	finish()
	expect(await pending).toMatchObject({ decision: "unknown" })
	expect(server.requests).toHaveLength(0)
})

it("discards an answer when permission changes while the provider is responding", async () => {
	const server = await provider(JSON.stringify({ decision: "same" }))
	server.delays.push(150)
	const pending = classifyWorkIntent(server.ctx, {
		...input,
		current: { workId, summary: "CSV export" },
		candidates: [],
	})
	await vi.waitFor(() => expect(server.requests).toHaveLength(1))
	vi.mocked(readConfigSetting).mockReturnValue(false)
	expect(await pending).toMatchObject({ decision: "unknown" })
})

it("does not dispatch retained task text after the account changes during authentication", async () => {
	const server = await provider(JSON.stringify({ decision: "same" }))
	let current = true
	vi.mocked(server.registry.getApiKeyAndHeaders).mockImplementationOnce(async () => {
		current = false
		return { ok: true, apiKey: "new-account-key", headers: {} }
	})
	expect(await classifyWorkIntent(server.ctx, input, undefined, () => current)).toMatchObject({ decision: "unknown" })
	expect(server.requests).toHaveLength(0)
})

it("pins model, session and work before authentication resolves", async () => {
	const server = await provider(JSON.stringify({ decision: "same" }))
	const original = getWorkId(server.ctx)
	let release!: () => void
	vi.mocked(server.registry.getApiKeyAndHeaders).mockImplementationOnce(async () => {
		await new Promise<void>((resolve) => {
			release = resolve
		})
		return { ok: true, apiKey: "selected-key", headers: {} }
	})
	const pending = classifyWorkIntent(server.ctx, {
		...input,
		current: { workId: original, summary: "CSV export" },
		candidates: [],
	})
	await vi.waitFor(() => expect(release).toBeDefined())
	server.ctx.model = createModel("later", "another")
	server.ctx.sessionManager.getSessionId = () => "later-session"
	setWorkId(server.ctx)
	release()
	expect(await pending).toEqual({ decision: "same", model: "selected/chat" })
	const request = server.requests[0]
	expect(request.headers["x-session-id"]).toBe("test-session")
	expect(readWorkRecords(join(server.root, "agent"))).toContainEqual(
		expect.objectContaining({
			type: "request",
			requestId: request.headers["x-request-id"],
			sessionId: "test-session",
			workId: original,
			model: "chat",
		}),
	)
})

it("cancels stalled authentication without dispatching a late request", async () => {
	const server = await provider(JSON.stringify({ decision: "same" }))
	let release!: () => void
	vi.mocked(server.registry.getApiKeyAndHeaders).mockImplementationOnce(async () => {
		await new Promise<void>((resolve) => {
			release = resolve
		})
		return { ok: true, apiKey: "selected-key", headers: {} }
	})
	const controller = new AbortController()
	const pending = classifyWorkIntent(server.ctx, input, controller.signal)
	await vi.waitFor(() => expect(release).toBeDefined())
	controller.abort()
	expect(await pending).toMatchObject({ decision: "unknown" })
	release()
	await new Promise((resolve) => setTimeout(resolve, 30))
	expect(server.requests).toHaveLength(0)
})

it("does not call auth or inference without history or a selected model", async () => {
	const server = await provider("{}")
	expect(await classifyWorkIntent(server.ctx, { current: null, candidates: [], message: "First task" })).toMatchObject({
		decision: "new",
	})
	server.ctx.model = undefined
	expect(await classifyWorkIntent(server.ctx, input)).toBeUndefined()
	expect(server.registry.getApiKeyAndHeaders).not.toHaveBeenCalled()
	expect(server.requests).toHaveLength(0)
})

it("bounds stalled authentication by the shared deadline", async () => {
	const server = await provider("{}")
	vi.mocked(server.registry.getApiKeyAndHeaders).mockImplementation(() => new Promise(() => {}))
	const pending = classifyWorkIntent(server.ctx, input)
	expect(await pending).toMatchObject({ decision: "unknown" })
	expect(server.requests).toHaveLength(0)
})

it.each(["success", "failure"])("respects configured redaction on %s", async (outcome) => {
	const server = await provider(JSON.stringify({ decision: "same" }))
	vi.spyOn(redactionConfig, "getRedactionConfig").mockReturnValue({ enabled: true })
	if (outcome === "success") vi.mocked(redactTextOrThrow).mockResolvedValue("Redacted task text")
	else vi.mocked(redactTextOrThrow).mockRejectedValue(new Error("Redaction failed"))
	const decision = await classifyWorkIntent(server.ctx, {
		...input,
		current: { workId, summary: "Private task text" },
		candidates: [],
	})
	expect(decision?.decision).toBe(outcome === "success" ? "same" : "unknown")
	expect(server.requests).toHaveLength(outcome === "success" ? 1 : 0)
	if (outcome === "success") {
		expect(server.requests[0].body).toContain("Redacted task text")
		expect(server.requests[0].body).not.toContain("Private task text")
	}
})

it("keeps work unchanged when authentication is unavailable", async () => {
	const server = await provider("{}")
	vi.mocked(server.registry.getApiKeyAndHeaders).mockRejectedValue(new Error("Auth unavailable"))
	expect(await classifyWorkIntent(server.ctx, input)).toMatchObject({ decision: "unknown" })
	expect(server.requests).toHaveLength(0)
})

it.each([
	{ decision: "unknown" },
	{ decision: "new" },
	{ decision: "same" },
	{ decision: "continue", workId },
	{ decision: "confirm" },
	{ decision: "match", workId },
])("abstains on an uncertain or invalid candidate result %j", async (answer) => {
	const server = await provider([JSON.stringify({ decision: "specific" }), JSON.stringify(answer)])
	expect(await classifyWorkIntent(server.ctx, input)).toMatchObject({ decision: "unknown" })
	const checked = JSON.parse(JSON.parse(server.requests[1].body).messages.at(-1).content)
	expect(checked).toEqual({ ...input, selectedWorkId: workId })
})

const otherCandidate = { workId: "20000000-0000-4000-8000-000000000002", summary: "Add JSON export" }

it("requires every other candidate to be ruled out before adopting one match", async () => {
	const candidates = [...input.candidates, otherCandidate]
	const server = await provider([
		JSON.stringify({ decision: "specific" }),
		JSON.stringify({ decision: "match" }),
		JSON.stringify({ decision: "different" }),
	])
	expect(await classifyWorkIntent(server.ctx, { ...input, candidates })).toMatchObject({
		decision: "continue",
		workId,
	})
	expect(server.requests).toHaveLength(3)
	for (const [index, candidate] of candidates.entries()) {
		const checked = JSON.parse(JSON.parse(server.requests[index + 1].body).messages.at(-1).content)
		expect(checked).toEqual({ ...input, candidates, selectedWorkId: candidate.workId })
	}
	const precheck = JSON.parse(JSON.parse(server.requests[0].body).messages.at(-1).content)
	expect(precheck).toEqual({ message: input.message })
})

it.each([
	{ decision: "unknown" },
	{ decision: "same" },
	{ decision: "specific", workId },
])("does not show candidates when the message alone cannot identify a task %j", async (answer) => {
	const server = await provider(JSON.stringify(answer))
	expect(await classifyWorkIntent(server.ctx, input)).toMatchObject({ decision: "unknown" })
	expect(server.requests).toHaveLength(1)
	const checked = JSON.parse(JSON.parse(server.requests[0].body).messages.at(-1).content)
	expect(checked).toEqual({ message: input.message })
})

it.each(["match", "unknown"])("does not adopt when another candidate is %s", async (decision) => {
	const server = await provider([
		JSON.stringify({ decision: "specific" }),
		JSON.stringify({ decision: "match" }),
		JSON.stringify({ decision }),
	])
	expect(
		await classifyWorkIntent(server.ctx, { ...input, candidates: [...input.candidates, otherCandidate] }),
	).toMatchObject({ decision: "unknown" })
	expect(server.requests).toHaveLength(3)
})

it("returns new only when every candidate is different", async () => {
	const server = await provider([
		JSON.stringify({ decision: "specific" }),
		JSON.stringify({ decision: "different" }),
		JSON.stringify({ decision: "different" }),
	])
	expect(
		await classifyWorkIntent(server.ctx, { ...input, candidates: [...input.candidates, otherCandidate] }),
	).toMatchObject({ decision: "new" })
	expect(server.requests).toHaveLength(3)
})

it("checks the current task alone before considering earlier candidates", async () => {
	const current = { workId: otherCandidate.workId, summary: "Clickable PR footer links" }
	const server = await provider(JSON.stringify({ decision: "same" }))
	expect(await classifyWorkIntent(server.ctx, { ...input, current })).toMatchObject({ decision: "same" })
	expect(server.requests).toHaveLength(1)
	const checked = JSON.parse(JSON.parse(server.requests[0].body).messages.at(-1).content)
	expect(checked).toEqual({ current, candidates: [], message: input.message })
})

it("preserves the original context after ruling out the current task", async () => {
	const current = { workId: otherCandidate.workId, summary: "Clickable PR footer links" }
	const server = await provider([
		JSON.stringify({ decision: "new" }),
		JSON.stringify({ decision: "specific" }),
		JSON.stringify({ decision: "match" }),
	])
	expect(await classifyWorkIntent(server.ctx, { ...input, current })).toMatchObject({
		decision: "continue",
		workId,
	})
	expect(server.requests).toHaveLength(3)
	const precheck = JSON.parse(JSON.parse(server.requests[1].body).messages.at(-1).content)
	expect(precheck).toEqual({ message: input.message })
	const checked = JSON.parse(JSON.parse(server.requests[2].body).messages.at(-1).content)
	expect(checked).toEqual({ ...input, current, selectedWorkId: workId })
})

it("shares one deadline across all candidate checks", async () => {
	const server = await provider([
		JSON.stringify({ decision: "specific" }),
		JSON.stringify({ decision: "match" }),
		JSON.stringify({ decision: "different" }),
	])
	server.delays.push(0, 1700, 1700)
	expect(
		await classifyWorkIntent(server.ctx, { ...input, candidates: [...input.candidates, otherCandidate] }),
	).toMatchObject({ decision: "unknown" })
	expect(server.requests).toHaveLength(3)
})

it("shares one deadline between the message precheck and candidate matching", async () => {
	const server = await provider([JSON.stringify({ decision: "specific" }), JSON.stringify({ decision: "match" })])
	server.delays.push(1700, 1700)
	expect(await classifyWorkIntent(server.ctx, input)).toMatchObject({ decision: "unknown" })
	expect(server.requests).toHaveLength(2)
})

it.each([
	{ decision: "continue", workId: "20000000-0000-4000-8000-000000000002" },
	{ decision: "same" },
	{ decision: "continue", workId, confidence: 1 },
	{ decision: "new", workId },
	{ decision: "execute" },
])("abstains on an invalid decision %j", async (answer) => {
	const server = await provider(JSON.stringify(answer))
	expect(await classifyWorkIntent(server.ctx, input)).toMatchObject({ decision: "unknown" })
})

it.each([204, 304])("abstains safely on an empty HTTP %s response", async (status) => {
	const server = await provider("", status)
	expect(await classifyWorkIntent(server.ctx, input)).toMatchObject({ decision: "unknown" })
	expect(server.requests).toHaveLength(1)
})

it("rejects oversized input instead of dropping disambiguating content", async () => {
	const server = await provider(JSON.stringify({ decision: "continue", workId }))
	expect(await classifyWorkIntent(server.ctx, { ...input, message: "x".repeat(13000) })).toMatchObject({
		decision: "unknown",
	})
	expect(server.requests).toHaveLength(0)
})

it("abstains when the selected provider is unavailable or aborted", async () => {
	const server = await provider("{}", 503)
	expect(await classifyWorkIntent(server.ctx, input)).toMatchObject({ decision: "unknown" })
	expect(await classifyWorkIntent(server.ctx, input, AbortSignal.abort())).toMatchObject({ decision: "unknown" })
})

it.each(["same", "new", "unknown"])("accepts the bounded %s decision for known current work", async (decision) => {
	const server = await provider(JSON.stringify({ decision }))
	expect(
		await classifyWorkIntent(server.ctx, {
			...input,
			current: { workId, summary: "CSV export" },
			candidates: [],
		}),
	).toEqual({ decision, model: "selected/chat" })
})

it("does not retry failed matching requests", async () => {
	const server = await provider("{}", 503)
	expect(await classifyWorkIntent(server.ctx, input)).toMatchObject({ decision: "unknown" })
	expect(server.requests).toHaveLength(1)
})

it("requests JSON from a selected Kimchi model without loosening decision parsing", async () => {
	const server = await provider(JSON.stringify({ decision: "same" }))
	if (!server.ctx.model) throw new Error("Missing fixture model")
	server.ctx.model.provider = "kimchi-dev"
	expect(
		await classifyWorkIntent(server.ctx, { ...input, current: { workId, summary: "CSV export" }, candidates: [] }),
	).toMatchObject({ decision: "same" })
	expect(JSON.parse(server.requests[0].body)).toMatchObject({
		response_format: {
			type: "json_schema",
			json_schema: { strict: true, schema: { additionalProperties: false, required: ["decision"] } },
		},
	})
})

it("does not persist or return malformed provider content", async () => {
	const server = await provider("x".repeat(70000))
	expect(await classifyWorkIntent(server.ctx, input)).toEqual({ decision: "unknown", model: "selected/chat" })
})

function repositoryFixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-semantic-metadata-")))
	roots.push(root)
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))
	const cwd = join(root, "repo")
	mkdirSync(cwd)
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
	git("init", "-q", "-b", "main")
	git(
		"-c",
		"user.name=Semantic Test",
		"-c",
		"user.email=test@example.invalid",
		"-c",
		"commit.gpgSign=false",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"Baseline",
	)
	return { root, cwd, git }
}

const currentId = "20000000-0000-4000-8000-000000000002"

it("keeps the first private intent with restrictive permissions and only skill user arguments", async () => {
	const { cwd } = repositoryFixture()
	await rememberWorkIntent(
		cwd,
		workId,
		'<skill name="plan" location="/private/SKILL.md">\nPrivate skill instructions\n</skill>\n\nAdd CSV export.',
	)
	await rememberWorkIntent(cwd, workId, "An unrelated later question")
	const saved = JSON.parse(readFileSync(workIntentPath(workId), "utf8"))
	expect(saved.summary).toBe("Add CSV export.")
	expect(JSON.stringify(saved)).not.toContain("Private skill")
	expect(statSync(workIntentPath(workId)).mode & 0o777).toBe(0o600)
	expect(statSync(dirname(workIntentPath(workId))).mode & 0o777).toBe(0o700)
})

it("does not save an oversized or empty task reference", async () => {
	const { cwd } = repositoryFixture()
	await rememberWorkIntent(cwd, workId, "x".repeat(4001))
	await rememberWorkIntent(cwd, currentId, "   ")
	expect((await loadWorkIntents(cwd, currentId, "Continue", true)).input).toMatchObject({
		current: null,
		candidates: [],
	})
})

it("loads retained plans from another worktree even after the planning worktree is deleted", async () => {
	const { cwd, root, git } = repositoryFixture()
	const planningTree = join(root, "planning")
	git("worktree", "add", "-q", "-b", "planning", planningTree)
	await rememberWorkIntent(planningTree, workId, "Plan CSV export")
	savePlanMarkdown({
		cwd: planningTree,
		workId,
		name: "csv",
		planText: "# Export\nQuote embedded commas and double quotes.\n",
	})
	git("worktree", "remove", "--force", planningTree)
	const loaded = await loadWorkIntents(cwd, currentId, input.message, true)
	expect(loaded.input.candidates).toEqual([{ workId, summary: expect.stringContaining("Quote embedded commas") }])
	expect(loaded.repository).toBe(realpathSync(join(cwd, ".git")))
	const other = join(root, "other")
	mkdirSync(other)
	execFileSync("git", ["init", "-q", other])
	expect((await loadWorkIntents(other, currentId, input.message, true)).input.candidates).toEqual([])
	expect((await loadWorkIntents(cwd, currentId, input.message, false)).input.candidates).toEqual([])
})

it.each([
	"not JSON",
	"null",
	JSON.stringify({ version: 2 }),
	JSON.stringify({ version: 1, workId: currentId, repository: "replace", summary: "Hidden competitor" }),
	JSON.stringify({ version: 1, workId, repository: "replace", summary: " " }),
	JSON.stringify({ version: 1, workId, repository: "replace", summary: "x".repeat(4001) }),
	"x".repeat(20001),
])("does not omit malformed candidate metadata and choose from a partial set (%#)", async (content) => {
	const { cwd } = repositoryFixture()
	await rememberWorkIntent(cwd, workId, "CSV export")
	writeFileSync(workIntentPath(workId), content.replace('"replace"', JSON.stringify(realpathSync(join(cwd, ".git")))))
	await expect(loadWorkIntents(cwd, currentId, input.message, true)).rejects.toThrow()
})

it.each([
	"identity",
	"size",
	"versions",
	"directory",
])("rejects retained plan %s problems without truncating candidates", async (kind) => {
	const { cwd } = repositoryFixture()
	await rememberWorkIntent(cwd, workId, "CSV export")
	const saved = savePlanMarkdown({ cwd, workId, name: "csv", planText: "# CSV export" })
	if (!saved.snapshotPath) throw new Error("Missing retained plan")
	if (kind === "identity") writeFileSync(saved.snapshotPath, `<!-- kimchi-work-id: ${currentId} -->\n# Other work`)
	else if (kind === "size") writeFileSync(saved.snapshotPath, "x".repeat(16001))
	else if (kind === "directory") {
		rmSync(dirname(saved.snapshotPath), { recursive: true })
		writeFileSync(dirname(saved.snapshotPath), "Not a plan directory")
	} else
		for (let index = 0; index < 33; index++)
			writeFileSync(join(dirname(saved.snapshotPath), `${index}.md`), "# Excess history")
	await expect(loadWorkIntents(cwd, currentId, input.message, true)).rejects.toThrow()
})

it("refuses an incomplete scan of large work history", async () => {
	const { root, cwd } = repositoryFixture()
	for (let index = 0; index < 257; index++)
		mkdirSync(join(root, "agent", "work", `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`), {
			recursive: true,
		})
	await expect(loadWorkIntents(cwd, currentId, input.message, true)).rejects.toThrow("Too many works")
})
