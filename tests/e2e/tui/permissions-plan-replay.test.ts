import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { CustomEntry } from "@earendil-works/pi-coding-agent"
import { expect, Key, test } from "@microsoft/tui-test"
import type { FermentV2JournalEntry } from "../../../src/extensions/ferment-v2/types.js"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import {
	createKimchiFixture,
	createKimchiSessionController,
	stopKimchi,
	TUI_TEST_CONFIG,
	writeTuiArtifact,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("Plan mode survives restart without another assistant turn", async ({ terminal }) => {
	const fixture = await createKimchiFixture({ responses: [{ stream: ["REPLAY_SESSION_READY"] }] })
	const sessionFile = join(fixture.workDir, "mode-replay.jsonl")
	const session = createKimchiSessionController(terminal, fixture, {
		extraArgs: ["--session", sessionFile],
		extraEnv: { ...fixture.seedEnv, KIMCHI_PERMISSIONS: "" },
	})
	const steps = []
	try {
		await session.start()
		await session.turn("Establish this session", "REPLAY_SESSION_READY")
		terminal.submit("/permissions mode plan")
		await waitForText(terminal, /plan(?: → shift\+tab)? · basic\b/, { full: false })
		steps.push({
			label: "user selected Plan without another model turn",
			at: new Date().toISOString(),
			view: viewText(terminal),
		})
		const beforeRestart = readEntries(sessionFile)
		expect(
			beforeRestart.filter((entry) => entry.type === "custom" && entry.customType === "permission_mode").at(-1)?.data,
		).toMatchObject({
			mode: "plan",
			initiatedBy: "user",
		})
		const requestCount = fixture.fake.requests.filter((entry) => entry.url === "/openai/v1/chat/completions").length
		await session.restart()
		await waitForText(terminal, /plan(?: → shift\+tab)? · basic\b/, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		expect(fixture.fake.requests.filter((entry) => entry.url === "/openai/v1/chat/completions")).toHaveLength(
			requestCount,
		)
		steps.push({
			label: "fresh process restored Plan without inference",
			at: new Date().toISOString(),
			view: viewText(terminal),
		})
		await writeTuiArtifact({ name: "permission-mode-immediate-replay", outcome: "pass", terminal, fixture, steps })
	} catch (error) {
		await writeTuiArtifact({
			name: "permission-mode-immediate-replay",
			outcome: "fail",
			terminal,
			fixture,
			steps,
			error,
		})
		throw error
	} finally {
		await session.quit().catch(() => {})
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop()
	}
})

for (const referenceState of ["changed", "missing"] as const) {
	test(`approved Markdown survives a ${referenceState} saved copy and paused restart`, async ({ terminal }) => {
		const plan = "# Approved Snapshot\n\n## Goal\nReturn exactly APPROVED_TOKEN, with no other text.\n\n"
		const blockedResponse = {
			toolCalls: [
				{
					id: "block",
					function: {
						name: "update_ferment_v2",
						arguments: JSON.stringify({ status: "blocked", reason: "Snapshot inspected." }),
					},
				},
			],
		}
		const fixture = await createKimchiFixture({
			gitInit: true,
			seedHome: (homeDir) => {
				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
				writeFileSync(
					settingsPath,
					JSON.stringify({
						...settings,
						multiModel: false,
						resources: { ...settings.resources, "extensions.ferment-v2": true },
					}),
				)
			},
			responses: [
				{
					stream: [plan],
					toolCalls: [{ id: "submit", function: { name: "ExitPlanMode", arguments: JSON.stringify({ plan }) } }],
				},
				blockedResponse,
				{
					stream: ["RESUMED_APPROVED_SNAPSHOT"],
					toolCalls: [{ ...blockedResponse.toolCalls[0], id: "block-resumed" }],
				},
			],
		})
		const sessionFile = join(fixture.workDir, "approved-replay.jsonl")
		const session = createKimchiSessionController(terminal, fixture, {
			extraArgs: ["--session", sessionFile],
			extraEnv: { ...fixture.seedEnv, KIMCHI_PERMISSIONS: "" },
		})
		const steps = []
		try {
			await session.start()
			terminal.submit("/permissions mode plan")
			await waitForText(terminal, /plan(?: → shift\+tab)? · basic\b/, { full: false })
			terminal.submit("Prepare the approved snapshot")
			await waitForText(terminal, "Execute the plan", { timeoutMs: STREAM_TIMEOUT_MS })
			const planPath = join(realpathSync(fixture.workDir), ".kimchi", "plans", "approved-snapshot.md")
			expect(readFileSync(planPath, "utf8")).toBe(plan)
			if (referenceState === "changed") writeFileSync(planPath, "# Unapproved\nReturn CHANGED_TOKEN.\n")
			else renameSync(planPath, `${planPath}.saved`)
			steps.push({
				label: `saved copy ${referenceState} before native approval`,
				at: new Date().toISOString(),
				view: viewText(terminal),
			})
			terminal.keyPress(Key.Enter)
			await waitForText(terminal, "Plan execution blocked.", { timeoutMs: STREAM_TIMEOUT_MS })
			const approved = lastRun(sessionFile)
			expect(approved?.objective).toContain(plan)
			expect(approved?.objective).toContain(`Saved plan copy (reference only): ${JSON.stringify(planPath)}`)
			expect(approved?.objective).not.toContain("CHANGED_TOKEN")
			expect(approved?.presentation).toMatchObject({ kind: "approved-plan", planPath })

			terminal.submit("/ferment-v2 pause")
			await waitForText(terminal, "Plan execution paused.", { full: false })
			if (referenceState === "changed") renameSync(planPath, `${planPath}.changed`)
			else writeFileSync(planPath, "# Unapproved\nReturn REPLACED_TOKEN.\n")
			const requestCount = fixture.fake.requests.filter((entry) => entry.url === "/openai/v1/chat/completions").length
			await session.restart()
			await waitForText(terminal, "Plan execution: paused", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
			expect(lastRun(sessionFile)).toMatchObject({
				id: approved?.id,
				revision: 1,
				objective: approved?.objective,
				status: "paused",
			})
			expect(fixture.fake.requests.filter((entry) => entry.url === "/openai/v1/chat/completions")).toHaveLength(
				requestCount,
			)
			steps.push({
				label: "paused restart retained exact approved objective despite changed reference",
				at: new Date().toISOString(),
				view: viewText(terminal),
			})

			const beforeSummary = lastRun(sessionFile)
			terminal.submit("/ferment-v2")
			await waitForText(terminal, "Plan:", { full: false })
			const summary = viewText(terminal).split("Plan execution: Approved Snapshot").at(-1) ?? ""
			expect(summary.replace(/\s+/g, "")).toContain(`Plan:${planPath}`)
			expect(summary).not.toContain("Objective:")
			expect(summary).not.toContain("<approved_plan>")
			expect(summary).not.toContain("APPROVED_TOKEN")
			expect(lastRun(sessionFile)).toEqual(beforeSummary)
			steps.push({
				label: "command shows the saved reference without repeating approved Markdown",
				at: new Date().toISOString(),
				view: viewText(terminal),
			})

			terminal.submit("/ferment-v2 resume")
			await waitForText(terminal, "RESUMED_APPROVED_SNAPSHOT", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await waitForText(terminal, "Plan execution blocked.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			const request = fixture.fake.requests
				.filter((entry) => entry.url.startsWith("/openai/v1/chat/completions"))
				.at(-1)
			const context = strings(request?.body).find((value) => value.includes("<kimchi_session_ferment_v2>"))
			expect(context).toContain(JSON.stringify(approved?.objective))
			expect(lastRun(sessionFile)).toMatchObject({
				id: approved?.id,
				revision: 1,
				objective: approved?.objective,
				status: "blocked",
			})
			steps.push({
				label: "explicit resume sent approved requirements, not saved-copy contents",
				at: new Date().toISOString(),
				view: viewText(terminal),
			})
			await writeTuiArtifact({
				name: `approved-plan-${referenceState}-replay`,
				outcome: "pass",
				terminal,
				fixture,
				steps,
			})
		} catch (error) {
			await writeTuiArtifact({
				name: `approved-plan-${referenceState}-replay`,
				outcome: "fail",
				terminal,
				fixture,
				steps,
				error,
			})
			throw error
		} finally {
			await session.quit().catch(() => {})
			await stopKimchi(terminal).catch(() => {})
			await fixture.stop()
		}
	})
}

test("approved plan edits save separate files and reopen full requirements after restart", async ({ terminal }) => {
	const plan = "# Editable Plan\n\nReturn APPROVED_TOKEN.\n"
	const secondRequirement = "SECOND_REQUIREMENT: also verify the result."
	const thirdRequirement = "THIRD_REQUIREMENT: preserve the previous revision."
	const readCurrentPlan = { id: "read-current-plan", function: { name: "read", arguments: "" } }
	const fixture = await createKimchiFixture({
		gitInit: true,
		seedHome: (homeDir) => {
			const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
			writeFileSync(
				settingsPath,
				JSON.stringify({
					...settings,
					multiModel: false,
					resources: { ...settings.resources, "extensions.ferment-v2": true },
				}),
			)
		},
		responses: [
			{
				stream: [plan],
				toolCalls: [{ id: "submit-editable", function: { name: "ExitPlanMode", arguments: JSON.stringify({ plan }) } }],
			},
			{
				toolCalls: [
					{
						id: "block-editable",
						function: {
							name: "update_ferment_v2",
							arguments: JSON.stringify({ status: "blocked", reason: "Ready for the user edit." }),
						},
					},
				],
			},
			{ stream: ["READING_CURRENT_PLAN"], toolCalls: [readCurrentPlan] },
			{
				stream: ["CURRENT_PLAN_READ"],
				toolCalls: [
					{
						id: "block-revised",
						function: {
							name: "update_ferment_v2",
							arguments: JSON.stringify({ status: "blocked", reason: "Revised requirements read." }),
						},
					},
				],
			},
		],
	})
	const sessionFile = join(fixture.workDir, "edited-plan-replay.jsonl")
	const session = createKimchiSessionController(terminal, fixture, {
		extraArgs: ["--session", sessionFile],
		extraEnv: { ...fixture.seedEnv, KIMCHI_PERMISSIONS: "" },
	})
	const steps = []
	try {
		await session.start()
		terminal.submit("/permissions mode plan")
		await waitForText(terminal, /plan(?: → shift\+tab)? · basic\b/, { full: false })
		terminal.submit("Prepare the editable plan.")
		await waitForText(terminal, "Execute the plan", { timeoutMs: STREAM_TIMEOUT_MS })
		terminal.keyPress(Key.Enter)
		await waitForText(terminal, "Plan execution blocked.", { timeoutMs: STREAM_TIMEOUT_MS })
		terminal.submit("/ferment-v2 pause")
		await waitForText(terminal, "Plan execution paused.", { full: false })
		const original = lastRun(sessionFile)
		if (!original) throw new Error("Approved plan snapshot was not persisted")
		const originalPath = join(realpathSync(fixture.workDir), ".kimchi", "plans", "editable-plan.md")
		expect(readFileSync(originalPath, "utf8")).toBe(plan)
		const originalEntries = readEntries(sessionFile)

		terminal.submit("/ferment-v2 edit")
		await waitForText(terminal, "Edit Plan execution", { full: false })
		await waitForText(terminal, "<approved_plan>", { full: false })
		expect(viewText(terminal).split("Edit Plan execution").at(-1)).toContain("APPROVED_TOKEN")
		terminal.keyPress("j", { ctrl: true })
		terminal.keyPress("j", { ctrl: true })
		terminal.write(secondRequirement)
		await waitForText(terminal, secondRequirement, { full: false })
		terminal.keyPress(Key.Enter)
		await waitForText(terminal, "Ferment V2 updated to revision 2.", { full: false })
		const revision2 = lastRun(sessionFile)
		if (!revision2) throw new Error("Edited revision 2 was not persisted")
		const revision2Path = managedObjectivePath(revision2.objective)
		const revision2Text = `${original.objective}\n\n${secondRequirement}`
		expect(revision2).toMatchObject({ id: original.id, revision: 2, status: "paused" })
		expect(revision2.presentation).toBeUndefined()
		expect(revision2Path).toMatch(/\/[0-9a-f-]{36}-objective\.md$/)
		expect(revision2Path).toContain(join(realpathSync(fixture.workDir), ".kimchi", "plans"))
		expect(readFileSync(revision2Path, "utf8")).toBe(revision2Text)
		expect(readFileSync(originalPath, "utf8")).toBe(plan)
		expect(readEntries(sessionFile).slice(0, originalEntries.length)).toEqual(originalEntries)
		terminal.submit("/ferment-v2")
		await waitForText(terminal, "Objective: Read the Kimchi objective file", { full: false })
		const summary = viewText(terminal).split("Status: paused").at(-1) ?? ""
		expect(summary.replace(/\s+/g, "")).toContain(revision2.objective.replace(/\s+/g, ""))
		expect(summary).not.toContain(secondRequirement)
		steps.push({
			label: "native editor saved revision 2 as a short reference without overwriting the approved snapshot",
			at: new Date().toISOString(),
			view: viewText(terminal),
		})

		await session.restart()
		await waitForText(terminal, "Ferment V2: paused", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		expect(lastRun(sessionFile)).toEqual(revision2)
		terminal.submit("/ferment-v2 edit")
		await waitForText(terminal, "Edit Ferment V2", { full: false })
		await waitForText(terminal, secondRequirement, { full: false })
		const editor = viewText(terminal).split("Edit Ferment V2").at(-1) ?? ""
		expect(editor).toContain("APPROVED_TOKEN")
		expect(editor).not.toContain("Read the Kimchi objective file")
		steps.push({
			label: "restarted native editor reopened full revision 2 requirements",
			at: new Date().toISOString(),
			view: viewText(terminal),
		})
		terminal.keyPress("j", { ctrl: true })
		terminal.keyPress("j", { ctrl: true })
		terminal.write(thirdRequirement)
		await waitForText(terminal, thirdRequirement, { full: false })
		terminal.keyPress(Key.Enter)
		await waitForText(terminal, "Ferment V2 updated to revision 3.", { full: false })
		const revision3 = lastRun(sessionFile)
		if (!revision3) throw new Error("Edited revision 3 was not persisted")
		const revision3Path = managedObjectivePath(revision3.objective)
		const revision3Text = `${revision2Text}\n\n${thirdRequirement}`
		expect(revision3).toMatchObject({ id: original.id, revision: 3, status: "paused" })
		expect(revision3Path).not.toBe(revision2Path)
		expect(readFileSync(revision3Path, "utf8")).toBe(revision3Text)
		expect(readFileSync(revision2Path, "utf8")).toBe(revision2Text)
		expect(readFileSync(originalPath, "utf8")).toBe(plan)

		readCurrentPlan.function.arguments = JSON.stringify({ path: revision3Path })
		terminal.submit("/ferment-v2 resume")
		await waitForText(terminal, "CURRENT_PLAN_READ", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
		await waitForText(terminal, "Ferment V2 blocked.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
		const workerRequests = fixture.fake.requests.filter((entry) => entry.url === "/openai/v1/chat/completions")
		expect(
			strings(workerRequests.at(-2)?.body).find((value) => value.includes("<kimchi_session_ferment_v2>")),
		).toContain(JSON.stringify(revision3.objective))
		const body = workerRequests.at(-1)?.body
		if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages))
			throw new Error("Missing worker messages after read")
		const readResult = body.messages.find(
			(message) => message.role === "tool" && message.tool_call_id === readCurrentPlan.id,
		)
		expect(strings(readResult?.content).join("\n")).toContain(revision3Text)
		steps.push({
			label:
				"explicit resume used the short reference and the real read tool returned complete revision 3 requirements",
			at: new Date().toISOString(),
			view: viewText(terminal),
		})
		await writeTuiArtifact({ name: "approved-plan-file-edit-replay", outcome: "pass", terminal, fixture, steps })
	} catch (error) {
		await writeTuiArtifact({ name: "approved-plan-file-edit-replay", outcome: "fail", terminal, fixture, steps, error })
		throw error
	} finally {
		await session.quit().catch(() => {})
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop()
	}
})

function managedObjectivePath(objective: string): string {
	const match = /^Read the Kimchi objective file at (".*") before continuing\.$/.exec(objective)
	if (!match) throw new Error(`Expected a managed objective reference, got: ${objective}`)
	return JSON.parse(match[1])
}

function readEntries<T = unknown>(path: string): CustomEntry<T>[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "custom")
}

function lastRun(path: string) {
	const entry = readEntries<FermentV2JournalEntry>(path).findLast(
		(entry) => entry.customType === "kimchi_ferment_v2_state",
	)
	return entry?.data.op === "put" ? entry.data.fermentV2 : undefined
}

function strings(value: unknown): string[] {
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) return value.flatMap(strings)
	if (value && typeof value === "object") return Object.values(value).flatMap(strings)
	return []
}
