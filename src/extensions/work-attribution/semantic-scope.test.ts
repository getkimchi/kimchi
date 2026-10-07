import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { InputEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import * as organizations from "../../api/organizations.js"
import * as settings from "../../config/settings.js"
import * as config from "../../config.js"
import { savePlanMarkdown } from "../../shared/planning/plan-markdown.js"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createModel, createModelRegistry } from "../__mocks__/model-registry.js"
import { createWorkAttributionExtension, getWorkId, recordProviderRequest } from "../work-attribution.js"
import { loadWorkIntents, rememberWorkIntent, workIntentPath } from "./semantic.js"
import { flushWorkSummaries, readWorkRecords } from "./summary.js"

const WORK = "10000000-0000-4000-8000-000000000001"
const CURRENT = "20000000-0000-4000-8000-000000000002"
const ORG = "30000000-0000-4000-8000-000000000003"
const USER = "40000000-0000-4000-8000-000000000004"
let root: string
let cwd: string
let key: string
let endpoint: string
let identity: organizations.VerifyApiKeyResponse

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-work-scope-")))
	cwd = join(root, "repo")
	mkdirSync(cwd)
	execFileSync("git", ["init", "-q", cwd])
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))
	key = randomUUID()
	endpoint = "https://account.example/api"
	identity = { organizationId: ORG, userId: USER }
	const original = config.loadConfig()
	const endpoints = config.resolveEndpoints()
	vi.spyOn(config, "loadConfig").mockImplementation(() => ({ ...original, apiKey: key }))
	vi.spyOn(config, "resolveEndpoints").mockImplementation(() => ({ ...endpoints, platformApiUrl: endpoint }))
	vi.spyOn(settings, "readConfigSetting").mockReturnValue(true)
	vi.spyOn(organizations, "verifyApiKey").mockImplementation(async () => identity)
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(root, { recursive: true, force: true })
})

it.each([
	"same",
	"organization",
	"actor",
	"endpoint",
	"repository",
	"missing",
])("checks the %s scope before adopting a named native plan", async (variant) => {
	const saved = savePlanMarkdown({ cwd, name: "export", planText: "# Export", workId: WORK })
	if (variant !== "missing")
		writeFileSync(
			join(root, "agent", "work", WORK, "scope.json"),
			JSON.stringify({
				version: 1,
				workId: WORK,
				repository: realpathSync(join(cwd, ".git")),
				account: { apiUrl: endpoint, organizationId: ORG, userId: USER },
			}),
		)
	if (variant === "organization") identity = { ...identity, organizationId: CURRENT }
	if (variant === "actor") identity = { ...identity, userId: CURRENT }
	if (variant === "endpoint") endpoint = "https://other.example/api"
	let implementingCwd = cwd
	if (variant === "repository") {
		implementingCwd = join(root, "other")
		execFileSync("git", ["init", "-q", implementingCwd])
	}
	const ctx = createContext({ cwd: implementingCwd })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	await api.getHandler<InputEvent>("input")({ type: "input", source: "rpc", text: `Implement ${saved.path}` }, ctx)
	if (variant === "same") expect(getWorkId(ctx)).toBe(WORK)
	else expect(getWorkId(ctx)).not.toBe(WORK)
})

it("persists authenticated account identity without storing the credential", async () => {
	await rememberWorkIntent(cwd, WORK, "Plan a CSV export")
	const raw = readFileSync(workIntentPath(WORK), "utf8")
	expect(JSON.parse(raw)).toMatchObject({
		version: 2,
		account: { apiUrl: endpoint, organizationId: ORG, userId: USER },
	})
	expect(raw).not.toContain(key)
	expect(raw).not.toContain("credentialHash")
})

it("starts separate work after an account switch and preserves the first requests' original scope", async () => {
	vi.mocked(settings.readConfigSetting).mockReturnValue(false)
	const ctx = createContext({ cwd })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const input = api.getHandler<InputEvent>("input")
	await input({ type: "input", source: "rpc", text: "Plan the export" }, ctx)
	const first = recordProviderRequest(ctx)
	const scopePath = join(root, "agent", "work", first.workId, "scope.json")
	const originalScope = readFileSync(scopePath, "utf8")
	key = randomUUID()
	identity = { organizationId: CURRENT, userId: USER }
	await input({ type: "input", source: "rpc", text: "Implement something for this account" }, ctx)
	const next = recordProviderRequest(ctx)
	expect(next.workId).not.toBe(first.workId)
	expect(readFileSync(scopePath, "utf8")).toBe(originalScope)
	const records = readWorkRecords(join(root, "agent"))
	expect(records.find((row) => row.type === "request" && row.requestId === first.requestId)?.scope).toMatchObject({
		account: { organizationId: ORG },
	})
	expect(records.find((row) => row.type === "request" && row.requestId === next.requestId)?.scope).toMatchObject({
		account: { organizationId: CURRENT },
	})
})

it("scopes a new work at its first verified input without relabelling earlier requests", async () => {
	vi.mocked(settings.readConfigSetting).mockReturnValue(false)
	vi.mocked(organizations.verifyApiKey).mockRejectedValueOnce(new Error("Offline"))
	const ctx = createContext({ cwd })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const input = api.getHandler<InputEvent>("input")
	await input({ type: "input", source: "rpc", text: "Plan the export" }, ctx)
	const first = recordProviderRequest(ctx)
	const original = readWorkRecords(join(root, "agent")).find((row) => row.requestId === first.requestId)

	await input({ type: "input", source: "rpc", text: "Implement the export" }, ctx)
	const next = recordProviderRequest(ctx)
	const records = readWorkRecords(join(root, "agent"))
	expect(next.workId).toBe(first.workId)
	expect(original?.scope).toBeNull()
	expect(records.find((row) => row.requestId === first.requestId)).toEqual(original)
	expect(records.find((row) => row.requestId === next.requestId)?.scope).toMatchObject({
		account: { apiUrl: endpoint, organizationId: ORG, userId: USER },
		repository: realpathSync(join(cwd, ".git")),
	})
})

it("recovers from a missing scope file without relabelling earlier requests", async () => {
	vi.mocked(settings.readConfigSetting).mockReturnValue(false)
	const ctx = createContext({ cwd })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const input = api.getHandler<InputEvent>("input")
	await input({ type: "input", source: "rpc", text: "Plan the export" }, ctx)
	const first = recordProviderRequest(ctx)
	const scopePath = join(root, "agent", "work", first.workId, "scope.json")
	rmSync(scopePath)
	const original = readWorkRecords(join(root, "agent")).find((row) => row.requestId === first.requestId)

	await input({ type: "input", source: "rpc", text: "Implement the export" }, ctx)
	const next = recordProviderRequest(ctx)
	const records = readWorkRecords(join(root, "agent"))
	expect(next.workId).not.toBe(first.workId)
	expect(records.find((row) => row.requestId === first.requestId)).toEqual(original)
	expect(existsSync(scopePath)).toBe(false)
	expect(records.find((row) => row.requestId === next.requestId)?.scope).toMatchObject({
		account: { apiUrl: endpoint, organizationId: ORG, userId: USER },
		repository: realpathSync(join(cwd, ".git")),
	})
})

it("stays quiet on every prompt when matching is on in a folder without Git", async () => {
	const model = createModel("chat", "selected")
	const ctx = createContext({ cwd: root, model, modelRegistry: createModelRegistry([model]) })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const input = api.getHandler<InputEvent>("input")
	for (const text of ["What does this script do?", "How do I run it?"])
		await input({ type: "input", source: "interactive", text }, ctx)
	expect(ctx.ui.notify).not.toHaveBeenCalled()
})

it("keeps an explicit legacy plan choice unscoped instead of silently replacing it", async () => {
	vi.mocked(settings.readConfigSetting).mockReturnValue(false)
	const saved = savePlanMarkdown({ cwd, name: "legacy", planText: "# Export", workId: WORK })
	const ctx = createContext({ cwd })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	await api.getRegisteredCommand("work").handler(saved.path, { ...createCommandContext(), ...ctx })
	await api.getHandler<InputEvent>("input")({ type: "input", source: "rpc", text: "Implement the selected plan" }, ctx)
	const request = recordProviderRequest(ctx)
	expect(request.workId).toBe(WORK)
	expect(readWorkRecords(join(root, "agent")).find((row) => row.requestId === request.requestId)?.scope).toBeNull()
	expect(existsSync(join(root, "agent", "work", WORK, "scope.json"))).toBe(false)
})

it.each(["organization", "actor", "endpoint"])("does not load another %s's retained task text", async (field) => {
	await rememberWorkIntent(cwd, WORK, "Private task in account A")
	key = randomUUID()
	if (field === "organization") identity = { ...identity, organizationId: CURRENT }
	else if (field === "actor") identity = { ...identity, userId: CURRENT }
	else endpoint = "https://other-account.example/api"
	const loaded = await loadWorkIntents(cwd, CURRENT, "Implement the task", true)
	expect(loaded.input.candidates).toEqual([])
	expect(JSON.stringify(loaded)).not.toContain("Private task in account A")
})

it("retains the same account across credential rotation", async () => {
	await rememberWorkIntent(cwd, WORK, "CSV export")
	key = randomUUID()
	const loaded = await loadWorkIntents(cwd, CURRENT, "Implement CSV export", true)
	expect(loaded.input.candidates).toEqual([{ workId: WORK, summary: "CSV export" }])
})

it("does not stamp today's account onto legacy unscoped text", async () => {
	const path = workIntentPath(WORK)
	mkdirSync(dirname(path), { recursive: true })
	const legacy = JSON.stringify({
		version: 1,
		workId: WORK,
		repository: realpathSync(join(cwd, ".git")),
		summary: "Unscoped old task",
	})
	writeFileSync(path, legacy)
	const loaded = await loadWorkIntents(cwd, CURRENT, "Implement the task", true)
	expect(loaded.input.candidates).toEqual([])
	await rememberWorkIntent(cwd, WORK, "New task on the current account")
	expect(readFileSync(path, "utf8")).toBe(legacy)
})

it("does not retain a matchable intent when authenticated actor identity is unavailable", async () => {
	identity = { organizationId: ORG }
	await rememberWorkIntent(cwd, WORK, "Task without an authenticated owner")
	expect(existsSync(workIntentPath(WORK))).toBe(false)
	const loaded = await loadWorkIntents(cwd, CURRENT, "Implement the task", true)
	expect(loaded.input.candidates).toEqual([])
})

it("does not save an intent under an account that changed during verification", async () => {
	let finish!: (value: organizations.VerifyApiKeyResponse) => void
	vi.mocked(organizations.verifyApiKey).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = rememberWorkIntent(cwd, WORK, "Private task")
	await vi.waitFor(() => expect(finish).toBeDefined(), { timeout: 100 })
	key = randomUUID()
	finish(identity)
	await pending
	expect(existsSync(workIntentPath(WORK))).toBe(false)
})
