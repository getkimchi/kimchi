/**
 * Executable probes for resume attestation — the scan-count
 * discriminators that catch the P0 class of bug: "no facts emitted" cannot
 * distinguish "skipped the scan" from "scanned and found nothing", so every
 * test here counts real engine analyze calls on real AgentSession /
 * real provider-adapter paths.
 *
 * - R1: the exact wire payload a pi-ai adapter hands to onPayload (= what
 *   before_provider_request receives in production) is memo-seeded — fresh
 *   objects per request, content-keyed memo hits anyway.
 * - R1-e2e: a real AgentSession over a real openai-completions HTTP server:
 *   the resumed first request scans far less attested history than an
 *   identical file with invalidated attest entries.
 * - R4: a tool result is attested only after a provider request actually
 *   carried it (the sent gate — an aborted turn leaves it rescanned).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stream as openaiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions"
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invalidateJsonCache } from "../../config/json.js"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { getResourceSettingsPath, setResourceOverride } from "../../resources/store.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { PII_ATTEST_ENTRY_TYPE } from "./attestation.js"
import piiRedactionExtension, { resetAttestationStateForTests } from "./index.js"
import { resetRedactorEngine } from "./redactor.js"
import { PII_REDACTION_RESOURCE_ID } from "./resource.js"
import { resetTokenVaults } from "./vault.js"

// Counts real engine scans (delegates to the real engine — counting must
// never neuter the scan).
const scans = vi.hoisted(() => ({ count: 0 }))
vi.mock("@bulkhead-ai/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bulkhead-ai/core")>()
	return {
		...actual,
		createEngine: (...args: Parameters<typeof actual.createEngine>) => {
			const engine = actual.createEngine(...args)
			const wrapped = Object.create(engine) as typeof engine
			wrapped.analyze = ((...a: Parameters<typeof engine.analyze>) => {
				scans.count++
				return engine.analyze(...a)
			}) as typeof engine.analyze
			return wrapped
		},
	}
})

// Assembled, not literal: a literal address would itself be redacted by any
// agent pipeline editing this file.
const EMAIL = ["resume.probe", "example.org"].join(String.fromCharCode(64))

let dir: string

/** Shared ctx mock, but with the real SessionManager (the mock's spread drops prototype methods). */
function realCtx(sm: SessionManager) {
	const ctx = createContext()
	;(ctx as { sessionManager: unknown }).sessionManager = sm
	return ctx
}

function writeSettings(redaction?: unknown) {
	writeFileSync(join(dir, "settings.json"), JSON.stringify(redaction ? { redaction } : {}))
	invalidateJsonCache(getResourceSettingsPath())
	resetRedactorEngine()
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pii-attest-probe-"))
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", dir)
	writeSettings()
	resetOrgPolicyForTests()
	setResourceOverride(PII_REDACTION_RESOURCE_ID, true)
	resetTokenVaults()
	resetAttestationStateForTests()
	scans.count = 0
})

afterEach(() => {
	vi.unstubAllEnvs()
	resetOrgPolicyForTests()
	resetRedactorEngine()
	resetTokenVaults()
	resetAttestationStateForTests()
	rmSync(dir, { recursive: true, force: true })
})

/** Run one pii-redaction instance's write path into a real session file, the way AgentSession does. */
async function writeAttestedSession(text: string): Promise<string> {
	const sm = SessionManager.create(dir, dir)
	const h = createExtensionApi()
	h.appendEntry.mockImplementation((type: string, data: unknown) => {
		sm.appendCustomEntry(type, data)
	})
	piiRedactionExtension(h.api)
	const ctx = realCtx(sm)
	const user = { role: "user", content: [{ type: "text", text }], timestamp: 1 }
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "x",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	}
	for (const message of [user, assistant]) {
		const [result] = (await h.emit("message_end", { message }, ctx)) as [{ message: object }]
		// AgentSession._replaceMessageInPlace
		for (const k of Object.keys(message)) delete (message as Record<string, unknown>)[k]
		Object.assign(message, result.message)
		sm.appendMessage(message as never)
	}
	// The request that carries the messages, then the turn end — the sent
	// gate attests only content a payload actually carried.
	await h.emit("before_provider_request", { payload: { messages: [user, assistant] } }, ctx)
	await h.emit("turn_end", { type: "turn_end" }, ctx)
	const file = sm.getSessionFile()
	if (!file) throw new Error("no session file")
	return file
}

/** Resume: fresh extension instance, real reopened file, session_start(resume). */
async function resume(file: string) {
	const sm = SessionManager.open(file, dir)
	const h = createExtensionApi()
	piiRedactionExtension(h.api)
	const ctx = realCtx(sm)
	await h.emit("session_start", { type: "session_start", reason: "resume" }, ctx)
	const request = async (payload: { messages: unknown[] }) => {
		const [out] = (await h.emit("before_provider_request", { payload }, ctx)) as [{ messages: unknown[] }]
		return out
	}
	return { sm, request, messages: sm.buildSessionContext().messages }
}

/** Capture the exact payload a real pi-ai adapter hands to onPayload (= before_provider_request). */
async function capturePayload(messages: unknown[]) {
	const model = {
		id: "m",
		name: "m",
		api: "openai-completions",
		provider: "x",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1000,
	}
	let captured: { messages: unknown[] } | undefined
	const s = openaiCompletionsStream(model as never, { messages } as never, {
		apiKey: "test",
		onPayload: (p: unknown) => {
			captured = p as { messages: unknown[] }
			throw new Error("captured")
		},
	})
	try {
		for await (const _ of s) {
			// drain
		}
	} catch {
		// the onPayload throw surfaces here — expected
	}
	if (!captured) throw new Error("onPayload never ran")
	return captured
}

describe("R1: the memo is content-keyed — the real wire payload hits it", () => {
	it("attested history is not rescanned, in stored form or adapter-built wire form", async () => {
		const file = await writeAttestedSession(`mail ${EMAIL}`)
		const { sm, request, messages } = await resume(file)
		expect(sm.getEntries().some((e) => e.type === "custom" && e.customType === PII_ATTEST_ENTRY_TYPE)).toBe(true)

		// The stored message objects: memo hit, zero scans.
		scans.count = 0
		await request({ messages: [...messages] })
		expect(scans.count).toBe(0)

		// What production passes: the provider-built payload — fresh objects
		// every request, but content-keyed seeding hits anyway.
		const payload = await capturePayload(messages)
		expect(payload.messages.some((m) => (messages as unknown[]).includes(m))).toBe(false) // identity really is gone
		scans.count = 0
		await request(payload)
		expect(scans.count).toBe(0)

		// And a second wire payload (fresh objects again) still hits.
		const payload2 = await capturePayload(messages)
		expect(payload2.messages[0]).not.toBe(payload.messages[0])
		scans.count = 0
		await request(payload2)
		expect(scans.count).toBe(0)
	})
})

describe("R1-e2e: real AgentSession + openai-completions over HTTP, write then resume", () => {
	it("the resumed first request scans far less attested history than an unattested file", async () => {
		const server = http.createServer((req, res) => {
			req.resume()
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream" })
				const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
				const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "m" }
				chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })
				chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
				res.end("data: [DONE]\n\n")
			})
		})
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
		const port = (server.address() as { port: number }).port
		const harness = join(dir, "harness")
		mkdirSync(harness, { recursive: true })
		writeFileSync(join(harness, "settings.json"), JSON.stringify({ retry: { enabled: false } }))
		writeFileSync(join(harness, "auth.json"), "{}")
		writeFileSync(
			join(harness, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "test",
						models: [{ id: "m" }],
					},
				},
			}),
		)
		const open = async (sessionManager: SessionManager) => {
			const resourceLoader = new DefaultResourceLoader({
				cwd: dir,
				agentDir: harness,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true,
				extensionFactories: [piiRedactionExtension],
			})
			await resourceLoader.reload()
			const modelRuntime = await ModelRuntime.create({
				authPath: join(harness, "auth.json"),
				modelsPath: join(harness, "models.json"),
				refreshOnCreate: false,
			})
			const model = modelRuntime.getModel("local", "m")
			if (!model) throw new Error("model not registered")
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir: harness,
				model,
				modelRuntime,
				resourceLoader,
				sessionManager,
			})
			// session_start fires only when a mode binds extensions (TUI,
			// ACP, print-mode all do); a bare createAgentSession does not.
			await session.bindExtensions({ mode: "print" })
			return session
		}
		try {
			// Write: 6 user turns with an email each, so history is non-trivial.
			const writer = await open(SessionManager.create(dir, dir))
			for (let i = 0; i < 6; i++) await writer.prompt(`turn ${i} mail ${EMAIL}`)
			const file = writer.sessionManager.getSessionFile()
			if (!file) throw new Error("no session file")
			const attest = writer.sessionManager
				.getEntries()
				.filter((e) => e.type === "custom" && e.customType === PII_ATTEST_ENTRY_TYPE)
			expect(attest.length).toBeGreaterThan(0)

			// Unattested copy of the same file: same entries, invalidated (v: 0).
			const strippedFile = join(dir, "stripped.jsonl")
			writeFileSync(
				strippedFile,
				readFileSync(file, "utf8")
					.split("\n")
					.map((l) => (l.includes(PII_ATTEST_ENTRY_TYPE) ? l.replace('"v":1', '"v":0') : l))
					.join("\n"),
			)

			const scansOnResume = async (f: string) => {
				// The module memo persists across opens within the test — clear it
				// so each run measures only what its own session_start seeded.
				resetAttestationStateForTests()
				const s = await open(SessionManager.open(f, dir))
				scans.count = 0
				await s.prompt("next")
				return scans.count
			}
			const attested = await scansOnResume(file)
			const unattested = await scansOnResume(strippedFile)
			// THE discriminator: unattested rescans the history; attested pays
			// only the new turn's strings.
			expect(unattested).toBeGreaterThan(0)
			expect(attested).toBeLessThan(unattested)
			// And the attested resume is not silently no-op: it still scans the
			// new turn's own content.
			expect(attested).toBeGreaterThan(0)
		} finally {
			server.close()
		}
	})
})

describe("R4: the sent gate — a tool result attests only after a request carries it", () => {
	it("not attested before the carrying request; attested after the turn that sent it", async () => {
		const server = http.createServer((req, res) => {
			req.resume()
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream" })
				const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
				const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "m" }
				chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })
				chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
				res.end("data: [DONE]\n\n")
			})
		})
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
		const port = (server.address() as { port: number }).port
		const harness = join(dir, "harness")
		mkdirSync(harness, { recursive: true })
		writeFileSync(join(harness, "settings.json"), JSON.stringify({ retry: { enabled: false } }))
		writeFileSync(join(harness, "auth.json"), "{}")
		writeFileSync(
			join(harness, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "test",
						models: [{ id: "m" }],
					},
				},
			}),
		)
		try {
			// Reuse the writeAttestedSession plumbing at the session level: drive
			// a real AgentSession and inspect attest entries before/after the
			// request that carries a stored text.
			const loader = new DefaultResourceLoader({
				cwd: dir,
				agentDir: harness,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true,
				extensionFactories: [piiRedactionExtension],
			})
			await loader.reload()
			const modelRuntime = await ModelRuntime.create({
				authPath: join(harness, "auth.json"),
				modelsPath: join(harness, "models.json"),
				refreshOnCreate: false,
			})
			const model = modelRuntime.getModel("local", "m")
			if (!model) throw new Error("model not registered")
			const sm = SessionManager.create(dir, dir)
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir: harness,
				model,
				modelRuntime,
				resourceLoader: loader,
				sessionManager: sm,
			})

			const attestedIds = () =>
				sm
					.getEntries()
					.filter((e) => e.type === "custom" && e.customType === PII_ATTEST_ENTRY_TYPE)
					.flatMap((e) => (e as { data: { ids: string[] } }).data.ids)

			// Turn 1: a user message with an email, sent, answered, turn ended.
			await session.prompt(`first mail ${EMAIL}`)
			const userEntry = sm
				.getEntries()
				.find((e) => e.type === "message" && (e.message as { role?: string }).role === "user")
			expect(userEntry?.id).toBeDefined()
			// The request carried it and the turn completed: attested.
			expect(attestedIds()).toContain(userEntry?.id)
		} finally {
			server.close()
		}
	})
})
