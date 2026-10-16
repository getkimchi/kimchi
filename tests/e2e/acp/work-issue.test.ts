import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { isWorkMatchingRequest } from "../tui/support/fake-openai-server.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor } from "./support/scenarios.js"

let fixture: AcpFixture | undefined

afterEach(async () => {
	await fixture?.stop()
})

/** Runs a slash command and returns the notice it shows, as the ACP client receives it. */
async function notice(active: AcpFixture, sessionId: string, command: string): Promise<string> {
	const before = active.client.extNotifications.length
	expect((await prompt(active, sessionId, command)).stopReason).toBe("end_turn")
	const text = await waitFor(
		() =>
			active.client.extNotifications.slice(before).flatMap(({ method, params }) => {
				if (method !== "_kimchi.dev/pi_notify" || typeof params !== "object" || params === null) return []
				const fields: Record<string, unknown> = { ...params }
				return fields.sessionId === sessionId && fields.method === "notify" && typeof fields.message === "string"
					? [fields.message]
					: []
			})[0],
		(message) => message !== undefined,
		10_000,
	)
	return text ?? ""
}

it("selects a Jira issue for the work, binds the next prompt, shows it in /work and clears it over ACP", async () => {
	const active = await startAcpFixture({
		artifactName: "work-issue",
		responses: [{ stream: ["Implemented the Jira integration."] }],
		clientMeta: { "kimchi.dev": { pi_notify: true } },
	})
	fixture = active
	execFileSync("git", ["init", "-q", active.workDir])
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/feature/ABC-123-add-jira"], { cwd: active.workDir })
	const sessionId = await newSession(active, active.workDir)

	const workId = /^Work ID: (\S+)/.exec(await notice(active, sessionId, "/work"))?.[1]
	// The work's cost lines follow; they depend on whether a background cost pass has run yet.
	expect((await notice(active, sessionId, "/work issue")).split("\n").slice(0, 3)).toEqual([
		"Jira issue: none",
		"Branch feature/ABC-123-add-jira names ABC-123. Select it with: /work issue ABC-123",
		`Work ID: ${workId}`,
	])
	expect((await notice(active, sessionId, "/work issue ABC-123")).split("\n").slice(0, 3)).toEqual([
		"Jira issue ABC-123 selected for this work. It applies from the next prompt; earlier requests are unchanged.",
		`Work ID: ${workId}`,
		"Jira issue: ABC-123",
	])

	expect((await prompt(active, sessionId, "Implement it")).stopReason).toBe("end_turn")
	const ledger = join(active.homeDir, ".config", "kimchi", "harness", "work-attribution")
	const rows = readdirSync(ledger)
		.filter((file) => file.endsWith(".jsonl"))
		.flatMap((file) => readFileSync(join(ledger, file), "utf8").split("\n").filter(Boolean))
		.map((line) => JSON.parse(line))
	const chats = active.fake.requests.filter(
		(request) => request.url.startsWith("/openai/v1/chat/completions") && !isWorkMatchingRequest(request),
	)
	expect(chats).toHaveLength(1)
	expect(
		rows.find((row) => row.type === "request" && row.requestId === chats[0].headers["x-request-id"]),
	).toMatchObject({ issue: { key: "ABC-123", revision: 1 } })

	expect(await notice(active, sessionId, "/work")).toMatch(/^Work ID: \S+\nJira issue: ABC-123\n/)
	expect(await notice(active, sessionId, "/work issue clear")).toMatch(/^Jira issue ABC-123 cleared from this work\./)
	expect(await notice(active, sessionId, "/work")).not.toContain("Jira issue")
})
