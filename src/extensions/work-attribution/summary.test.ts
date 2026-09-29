import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as asyncFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { BeforeProviderHeadersEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import * as locks from "proper-lockfile"
import { lockSync } from "proper-lockfile"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import {
	appendWorkRecord,
	createWorkAttributionExtension,
	getWorkId,
	recordProviderRequest,
	setWorkId,
} from "../work-attribution.js"

import { flushWorkSummaries, recoverWorkSummaries } from "./summary.js"

vi.mock("proper-lockfile", async (importOriginal) => ({ ...(await importOriginal<typeof locks>()) }))
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof asyncFs>()) }))
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))

let dir: string
beforeEach(() => {
	dir = fs.mkdtempSync(join(tmpdir(), "kimchi-work-summary-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	fs.rmSync(dir, { recursive: true, force: true })
})
function context(sessionId = "parent") {
	return createContext({ cwd: "/project", sessionManager: { getSessionId: () => sessionId } })
}
function path(workId: string) {
	return join(dir, "work", workId, "work.json")
}
function summary(workId: string) {
	return JSON.parse(fs.readFileSync(path(workId), "utf8"))
}

describe("readable work summaries", () => {
	it("finishes the turn while summary publication is pending, but drains it on shutdown", async () => {
		const originalRename = asyncFs.rename
		let release!: () => void
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		vi.spyOn(asyncFs, "rename").mockImplementation(async (...args) => {
			await blocked
			return originalRename(...args)
		})
		const mock = createExtensionApi()
		const ctx = context()
		createWorkAttributionExtension()(mock.api)
		const request = recordProviderRequest(ctx)
		const end = (async () => {
			for (const handler of mock.getHandlers("agent_end")) await handler({ type: "agent_end", messages: [] }, ctx)
		})()
		let shutdownFinished = false
		const shutdown = (async () => {
			for (const handler of mock.getHandlers("session_shutdown"))
				await handler({ type: "session_shutdown", reason: "quit" }, ctx)
			shutdownFinished = true
		})()
		try {
			expect(
				await Promise.race([end.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))]),
			).toBe(true)
			expect(shutdownFinished).toBe(false)
		} finally {
			release()
			await Promise.all([end, shutdown])
		}
		expect(summary(request.workId).requests).toContainEqual(expect.objectContaining({ requestId: request.requestId }))
	})
	it("automatically separates work while merging parent, child, request, plan and commit provenance", async () => {
		const parent = context()
		const child = context("child")
		const workId = getWorkId(parent)
		setWorkId(child, workId)
		const first = recordProviderRequest(parent, { provider: "test", id: "model" })
		const second = recordProviderRequest(child, { provider: "test", id: "model" })
		appendWorkRecord(child, { type: "plan", path: "/project/plan.md" })
		const commit = {
			type: "commit",
			sha: "sha",
			repository: "/project/.git",
			worktree: "/project",
			paths: ["a.ts"],
			transitionIds: ["first"],
		}
		appendWorkRecord(child, commit)
		appendWorkRecord(child, commit)
		appendWorkRecord(child, { ...commit, paths: ["b.ts"], transitionIds: ["second"] })
		const next = setWorkId(parent)
		recordProviderRequest(parent)
		await flushWorkSummaries()
		const value = summary(workId)
		expect(value).toMatchObject({ version: 1, workId, sessions: expect.arrayContaining(["parent", "child"]) })
		expect(value.requests).toHaveLength(2)
		expect(value.requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ requestId: first.requestId, sessionId: "parent", model: "model" }),
				expect.objectContaining({ requestId: second.requestId, sessionId: "child" }),
			]),
		)
		expect(value.plans).toEqual([expect.objectContaining({ path: "/project/plan.md", sessionId: "child" })])
		expect(value.commits).toEqual([
			expect.objectContaining({
				sha: "sha",
				sessionId: "child",
				paths: ["a.ts", "b.ts"],
				transitionIds: ["first", "second"],
			}),
		])
		expect(value.requests[0]).not.toHaveProperty("workId")
		expect(value.requests[0]).not.toHaveProperty("version")
		expect(value.requests[0]).not.toHaveProperty("type")
		expect(summary(next).requests).toHaveLength(1)
		expect(fs.readFileSync(path(workId), "utf8")).toContain('\n  "workId":')
	})
	it("retains different originating sessions for the same commit and ignores native transition journals", async () => {
		const workId = getWorkId(context())
		for (const session of ["parent", "child"])
			appendWorkRecord(
				context(session),
				{ type: "commit", sha: "sha", repository: "/repo", worktree: "/tree", paths: [session] },
				workId,
			)
		appendWorkRecord(
			context(),
			{ type: "file_transition", transitionId: "transition" },
			workId,
			join(dir, "work-attribution", "transitions", "journal.jsonl"),
		)
		await flushWorkSummaries()
		expect(
			summary(workId)
				.commits.map((entry: { sessionId: string }) => entry.sessionId)
				.sort(),
		).toEqual(["child", "parent"])
		expect(summary(workId)).not.toHaveProperty("file_transition")
	})
	it.each([
		undefined,
		"{",
		"null",
		"[]",
		'{"version":1,"workId":"WORK_ID","sessions":[],"requests":[null],"plans":[],"commits":[]}',
		'{"version":1,"workId":"wrong","sessions":[],"requests":[],"plans":[],"commits":[]}',
	])("recovers missing or invalid summaries (%s) from existing ledgers on launch", async (corrupt) => {
		const workId = randomUUID()
		const ctx = context()
		appendWorkRecord(ctx, { type: "request", requestId: "old-request", provider: "test", model: "old" }, workId)
		appendWorkRecord(context("child"), { type: "plan", path: "/old-plan.md" }, workId)
		await flushWorkSummaries()
		fs.appendFileSync(join(dir, "work-attribution", "parent.jsonl"), '{"type":"request"')
		fs.mkdirSync(dirname(path(workId)), { recursive: true })
		if (corrupt === undefined) fs.rmSync(path(workId), { force: true })
		else fs.writeFileSync(path(workId), corrupt.replace("WORK_ID", workId))
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		await api.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "startup" },
			context("fresh"),
		)
		await flushWorkSummaries()
		expect(summary(workId)).toMatchObject({
			workId,
			sessions: expect.arrayContaining(["parent", "child"]),
			requests: [expect.objectContaining({ requestId: "old-request", sessionId: "parent" })],
			plans: [expect.objectContaining({ path: "/old-plan.md", sessionId: "child" })],
		})
	})
	it("keeps a durable request header when the derived summary directory is blocked", async () => {
		fs.writeFileSync(join(dir, "work"), "blocked")
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(event, context())
		const rows = fs
			.readFileSync(join(dir, "work-attribution", "parent.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		expect(event.headers["X-Request-Id"]).toBe(rows.find((row) => row.type === "request").requestId)
		await flushWorkSummaries()
		expect(warn).toHaveBeenCalled()
	})
	it("does not scan unrelated histories for an ordinary append", async () => {
		const workId = getWorkId(context())
		await flushWorkSummaries()
		summary(workId)
		const scan = vi.spyOn(fs, "readdirSync")
		recordProviderRequest(context())
		await flushWorkSummaries()
		expect(scan).not.toHaveBeenCalled()
		expect(summary(workId).requests).toHaveLength(1)
	})
	it("drains an append that arrives while the asynchronous lock is being released", async () => {
		const ctx = context()
		const workId = getWorkId(ctx)
		await flushWorkSummaries()
		const originalLock = locks.lock
		let appended = false
		vi.spyOn(locks, "lock").mockImplementation(async (...args) => {
			const release = await originalLock(...args)
			return async () => {
				if (!appended) {
					appended = true
					appendWorkRecord(ctx, { type: "request", requestId: "during-release" }, workId)
				}
				await release()
			}
		})
		const release = lockSync(dirname(path(workId)))
		appendWorkRecord(ctx, { type: "request", requestId: "queued" }, workId)
		release()
		await flushWorkSummaries()
		expect(summary(workId).requests.map((row: { requestId: string }) => row.requestId)).toEqual([
			"queued",
			"during-release",
		])
	})
	it("does one recovery scan per agent directory despite child session fanout", async () => {
		const workId = getWorkId(context())
		await flushWorkSummaries()
		const scan = vi.spyOn(fs, "readdirSync")
		for (const session of ["first", "child", "next-child"]) {
			const api = createExtensionApi()
			createWorkAttributionExtension(workId)(api.api)
			await api.getHandler<SessionStartEvent>("session_start")(
				{ type: "session_start", reason: "startup" },
				context(session),
			)
		}
		expect(scan).toHaveBeenCalledTimes(1)
	})

	it.each([
		"write",
		"rename",
		"fsync",
	])("keeps durable requests recoverable after a summary %s failure", async (failure) => {
		const ctx = context()
		const workId = getWorkId(ctx)
		await flushWorkSummaries()
		const originalOpen = asyncFs.open
		vi.spyOn(asyncFs, "open").mockImplementation(async (...args) => {
			const file = await originalOpen(...args)
			if (failure === "write")
				vi.spyOn(file, "writeFile").mockRejectedValue(new Error("injected summary write failure"))
			if (failure === "fsync") vi.spyOn(file, "sync").mockRejectedValue(new Error("injected summary fsync failure"))
			return file
		})
		if (failure === "rename")
			vi.spyOn(asyncFs, "rename").mockRejectedValue(new Error("injected summary rename failure"))
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const request = recordProviderRequest(ctx)
		await flushWorkSummaries()
		expect(summary(workId).requests).toEqual([])
		expect(fs.readFileSync(join(dir, "work-attribution", "parent.jsonl"), "utf8")).toContain(request.requestId)
		expect(fs.readdirSync(dirname(path(workId))).some((file) => file.endsWith(".tmp"))).toBe(false)
		expect(warn).toHaveBeenCalled()
		vi.restoreAllMocks()
		recoverWorkSummaries()
		await flushWorkSummaries()
		expect(summary(workId).requests).toEqual([expect.objectContaining({ requestId: request.requestId })])
	})
	it("does not rename a summary when its lease is lost during publication", async () => {
		const ctx = context()
		const workId = getWorkId(ctx)
		await flushWorkSummaries()
		const originalLock = locks.lock
		let loseLease: (() => void) | undefined
		vi.spyOn(locks, "lock").mockImplementation(async (file, options) => {
			const release = await originalLock(file, options)
			loseLease = () =>
				options?.onCompromised?.(Object.assign(new Error("lease lost during fsync"), { code: "ECOMPROMISED" }))
			return release
		})
		const originalOpen = asyncFs.open
		vi.spyOn(asyncFs, "open").mockImplementation(async (...args) => {
			const file = await originalOpen(...args)
			const sync = file.sync.bind(file)
			vi.spyOn(file, "sync").mockImplementation(async () => {
				await sync()
				loseLease?.()
			})
			return file
		})
		const rename = vi.spyOn(asyncFs, "rename")
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const request = recordProviderRequest(ctx)
		await flushWorkSummaries()
		expect(rename).not.toHaveBeenCalled()
		expect(summary(workId).requests).toEqual([])
		expect(fs.readFileSync(join(dir, "work-attribution", "parent.jsonl"), "utf8")).toContain(request.requestId)
		expect(warn).toHaveBeenCalled()
		// This test invokes the observer directly; release the still-owned real fixture lease.
		await locks.unlock(dirname(path(workId)))
	})
	it("survives a real compromised lock and refuses to publish after losing ownership", async () => {
		const workId = getWorkId(context())
		await flushWorkSummaries()
		const requestId = randomUUID()
		const directory = dirname(path(workId))
		const release = lockSync(directory)
		const script = join(dir, "compromised.mts")
		fs.writeFileSync(
			script,
			`import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const locks = createRequire(${JSON.stringify(join(process.cwd(), "package.json"))})("proper-lockfile");
const original = locks.lock;
locks.lock = async (...args) => { const release = await original(...args); console.log("held"); await delay(3500); return release; };
const { appendWorkRecord } = await import(${JSON.stringify(new URL("../work-attribution.ts", import.meta.url).pathname)});
const { flushWorkSummaries } = await import(${JSON.stringify(new URL("./summary.ts", import.meta.url).pathname)});
appendWorkRecord({cwd:"/project",sessionManager:{getSessionId:()=>"compromised"}},{type:"request",requestId:${JSON.stringify(requestId)}},${JSON.stringify(workId)});
console.log("durable"); await flushWorkSummaries();`,
		)
		const child = spawn(process.execPath, ["--import", "tsx", script], {
			env: { ...process.env, PI_CODING_AGENT_DIR: dir },
		})
		let output = "",
			errors = "",
			released = false,
			removed = false
		child.stdout.on("data", (chunk) => {
			output += chunk
			if (!released && output.includes("durable")) {
				release()
				released = true
			}
			if (!removed && output.includes("held")) {
				fs.rmSync(`${directory}.lock`, { recursive: true, force: true })
				removed = true
			}
		})
		child.stderr.on("data", (chunk) => {
			errors += chunk
		})
		const timeout = setTimeout(() => child.kill("SIGKILL"), 10000)
		try {
			const code = await new Promise<number | null>((resolve) => child.once("exit", resolve))
			expect(code, errors).toBe(0)
			expect(errors).toContain("Work summary unavailable")
			expect(summary(workId).requests).toEqual([])
			recoverWorkSummaries()
			await flushWorkSummaries()
			expect(summary(workId).requests).toEqual([expect.objectContaining({ requestId, sessionId: "compromised" })])
		} finally {
			clearTimeout(timeout)
			if (!released) release()
			child.kill()
		}
	}, 15000)

	it("serializes simultaneous processes without lost updates or truncated publication", async () => {
		const workId = randomUUID()
		const directory = dirname(path(workId))
		fs.mkdirSync(directory, { recursive: true })
		fs.writeFileSync(
			path(workId),
			JSON.stringify({ version: 1, workId, sessions: [], requests: [], plans: [], commits: [] }),
		)
		const release = lockSync(directory)
		const script = join(dir, "writer.mts")
		fs.writeFileSync(
			script,
			`import { appendWorkRecord } from ${JSON.stringify(new URL("../work-attribution.ts", import.meta.url).pathname)};
import { flushWorkSummaries, recoverWorkSummaries } from ${JSON.stringify(new URL("./summary.ts", import.meta.url).pathname)};
const ctx = { cwd: "/project", sessionManager: { getSessionId: () => process.argv[2] } };
for(let i=0;i<8;i++) appendWorkRecord(ctx,{type:"request",requestId:process.argv[2]+"-"+i},${JSON.stringify(workId)});
console.log("ready"); await flushWorkSummaries();`,
		)
		const children = Array.from({ length: 3 }, (_, index) => {
			const child = spawn(process.execPath, ["--import", "tsx", script, `session-${index}`], {
				env: { ...process.env, PI_CODING_AGENT_DIR: dir },
			})
			let stderr = ""
			child.stderr.on("data", (chunk) => {
				stderr += chunk
			})
			const ready = new Promise<void>((resolve, reject) => {
				child.stdout.on("data", (chunk) => {
					if (String(chunk).includes("ready")) resolve()
				})
				child.once("exit", (code) => {
					if (code) reject(new Error(stderr))
				})
			})
			const done = new Promise<void>((resolve, reject) =>
				child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr)))),
			)
			void done.catch(() => {})
			return { child, ready, done }
		})
		let reading: ReturnType<typeof setInterval> | undefined
		const errors: unknown[] = []
		try {
			await Promise.all(children.map((child) => child.ready))
			reading = setInterval(() => {
				if (fs.existsSync(path(workId))) {
					try {
						summary(workId)
					} catch (error) {
						errors.push(error)
					}
				}
			}, 1)
			release()
			await Promise.all(children.map((child) => child.done))
			expect(errors).toEqual([])
			expect(summary(workId).requests).toHaveLength(24)
			expect(summary(workId).sessions.sort()).toEqual(["session-0", "session-1", "session-2"])
		} finally {
			if (reading) clearInterval(reading)
			for (const { child } of children) child.kill()
		}
	}, 15000)
})
