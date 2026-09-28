import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { getSessionRoleInfo, getSessionRoles, INTERNAL_SESSION_ENTRY } from "./session-visibility.js"

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function savedSession(marker: boolean, name: string, prompt = "Ordinary work") {
	const directory = mkdtempSync(join(tmpdir(), "kimchi-session-visibility-"))
	directories.push(directory)
	const timestamp = new Date().toISOString()
	const entries = [
		{
			type: "session",
			version: 3,
			id: "child",
			cwd: directory,
			timestamp,
			parentSession: join(directory, "parent.jsonl"),
		},
		...(marker
			? [
					{
						type: "custom",
						id: "marker",
						timestamp,
						customType: INTERNAL_SESSION_ENTRY,
						data: { kind: "ferment-evaluator" },
					},
				]
			: []),
		{ type: "session_info", id: "name", timestamp, name },
		{ type: "model_change", id: "model", timestamp, provider: "test", modelId: "evaluator-model" },
		{ type: "message", id: "message", timestamp, message: { role: "user", content: prompt, timestamp: Date.now() } },
	]
	writeFileSync(join(directory, "child.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"))
	const sessions = await SessionManager.list(directory, directory)
	expect(sessions).toHaveLength(1)
	return sessions[0]
}

describe("internal session classification", () => {
	it("recovers legacy roles from their shared parent without labeling unrelated forks", async () => {
		const reviewer = await savedSession(false, "Renamed review")
		const builder = { ...reviewer, path: `${reviewer.path}.builder`, name: "Implement changes" }
		const fork = { ...reviewer, path: `${reviewer.path}.fork` }
		const parentPath = reviewer.parentSessionPath ?? ""
		writeFileSync(
			parentPath,
			[
				JSON.stringify({ type: "message", message: { content: "Large parent history ".repeat(10_000) } }),
				...[
					{ sessionFile: reviewer.path, type: "Reviewer" },
					{ sessionFile: builder.path, type: "Builder" },
					{ sessionFile: fork.path, type: 42 },
				].map((data) => JSON.stringify({ type: "custom", customType: "subagents:record", data })),
				'{"type":',
			].join("\n"),
		)
		const roles = await getSessionRoles([reviewer, builder, fork])
		expect(roles.get(reviewer)).toEqual({ kind: "subagent", name: "Reviewer" })
		expect(roles.get(builder)).toEqual({ kind: "subagent", name: "Builder" })
		expect(roles.has(fork)).toBe(false)
		rmSync(parentPath)
		expect((await getSessionRoles([reviewer])).has(reviewer)).toBe(false)
	})

	it("prefers explicit child metadata over a parent record", async () => {
		const evaluator = await savedSession(true, "Renamed check")
		writeFileSync(
			evaluator.parentSessionPath ?? "",
			JSON.stringify({
				type: "custom",
				customType: "subagents:record",
				data: { sessionFile: evaluator.path, type: "Reviewer" },
			}),
		)
		expect((await getSessionRoles([evaluator])).get(evaluator)).toEqual({
			kind: "ferment-evaluator",
			model: "test/evaluator-model",
		})
	})

	it("reads metadata before a first message larger than the bounded header read", async () => {
		const session = await savedSession(true, "Large evaluator", "Objective details ".repeat(10_000))
		expect(await getSessionRoleInfo(session)).toEqual({ kind: "ferment-evaluator", model: "test/evaluator-model" })
	})
	it("keeps the initial model after later model changes and an interrupted final write", async () => {
		const session = await savedSession(true, "Evaluator")
		appendFileSync(
			session.path,
			`\n${JSON.stringify({ type: "model_change", provider: "other", modelId: "later" })}\n{"type":`,
		)
		expect(await getSessionRoleInfo(session)).toEqual({ kind: "ferment-evaluator", model: "test/evaluator-model" })
	})
	it("does not describe an unknown internal kind as a completion evaluator", async () => {
		const session = await savedSession(true, "Other internal")
		writeFileSync(session.path, readFileSync(session.path, "utf8").replace('"ferment-evaluator"', '"other"'))
		expect(await getSessionRoleInfo(session)).toEqual({ kind: "internal", model: "test/evaluator-model" })
	})

	it("recognizes the persisted marker even after renaming", async () => {
		expect(await getSessionRoleInfo(await savedSession(true, "A renamed session"))).toEqual({
			kind: "ferment-evaluator",
			model: "test/evaluator-model",
		})
	})
	it("preserves ordinary branches with an evaluator-like name", async () => {
		expect(await getSessionRoleInfo(await savedSession(false, "Ferment V2 evaluator"))).toBeUndefined()
	})
	it("recognizes legacy evaluator sessions by their reserved name and prompt structure", async () => {
		const session = await savedSession(
			false,
			"Ferment V2 evaluator",
			"Objective:\nFix it\n\nCurrent Todo state:\n[]\n\nDurable Ferment V2 lessons:\n(none)",
		)
		expect(await getSessionRoleInfo(session)).toEqual({ kind: "ferment-evaluator", model: "test/evaluator-model" })
	})
	it("does not hide an unreadable or concurrently removed session", async () => {
		const session = await savedSession(true, "Internal")
		rmSync(session.path)
		expect(await getSessionRoleInfo(session)).toBeUndefined()
	})
})
