// ACP e2e — document-skill CLI route permission behavior on the protocol
// surface.
//
// `kimchi doc-cli …` is the in-binary route the bundled document skills
// drive: the binary resolves and loads the staged CLI itself, the model
// only supplies the fixed command shape. These tests pin the permission
// contract on ACP: in auto mode the documented shape runs with no
// permission round-trip and produces the artifact; default mode still
// asks. The gate is the shared tool_call handler — TUI parity is covered
// by the unit suite (permissions/index.test.ts).

import { execFileSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitForSessionUpdate } from "./support/scenarios.js"

const repoRoot = process.env.KIMCHI_REPO_ROOT
	? resolve(process.env.KIMCHI_REPO_ROOT)
	: resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const binaryDir = join(repoRoot, "dist", "bin")

/** Make the built binary resolvable as bare `kimchi` inside the session's
 *  bash tool, and pin the permission mode. Restores both on teardown. */
async function withDocCliEnv(mode: undefined | "auto" | "plan", run: () => Promise<void>): Promise<void> {
	const prevPermissions = process.env.KIMCHI_PERMISSIONS
	const prevPath = process.env.PATH
	if (mode === "auto" || mode === "plan") process.env.KIMCHI_PERMISSIONS = mode
	process.env.PATH = `${binaryDir}${delimiter}${process.env.PATH ?? ""}`
	try {
		await run()
	} finally {
		if (prevPermissions === undefined) Reflect.deleteProperty(process.env, "KIMCHI_PERMISSIONS")
		else process.env.KIMCHI_PERMISSIONS = prevPermissions
		process.env.PATH = prevPath
	}
}

async function driveDocCliCreate(
	artifactName: string,
): Promise<{ fixture: Awaited<ReturnType<typeof startAcpFixture>>; sessionId: string }> {
	const fixture = await startAcpFixture({
		artifactName,
		responses: [
			{
				toolCalls: [
					{
						id: "call_doccli",
						function: {
							name: "bash",
							arguments: JSON.stringify({ command: "kimchi doc-cli pdf create hello.pdf --content hello.md" }),
						},
					},
				],
			},
			{ stream: ["PDF created."] },
		],
	})
	writeFileSync(join(fixture.workDir, "hello.md"), "# ACP doc-cli\n\nCreated through the in-binary route.\n")
	const sessionId = await newSession(fixture, fixture.workDir)
	const result = await prompt(fixture, sessionId, "Create the PDF")
	expect(result.stopReason, "turn stop reason").toBe("end_turn")
	await waitForSessionUpdate(
		fixture,
		sessionId,
		(update) =>
			update.sessionUpdate === "agent_message_chunk" &&
			update.content.type === "text" &&
			update.content.text.includes("PDF created."),
	)
	return { fixture, sessionId }
}

it(
	"auto mode runs doc-cli with no permission round-trip (ACP)",
	async () => {
		await withDocCliEnv("auto", async () => {
			const { fixture, sessionId } = await driveDocCliCreate("doc-cli-auto-allow")
			void sessionId
			try {
				// The deterministic gate accepted the command: no permission
				// request crossed the protocol surface.
				expect(fixture.client.permissionRequests).toEqual([])
				expect(existsSync(join(fixture.workDir, "hello.pdf")), "artifact created").toBe(true)
			} finally {
				await fixture.stop()
			}
		})
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"default mode still asks before running doc-cli (ACP)",
	async () => {
		await withDocCliEnv(undefined, async () => {
			const { fixture, sessionId } = await driveDocCliCreate("doc-cli-default-prompts")
			void sessionId
			try {
				// Default mode prompts per action; the fixture client
				// auto-approves allow_once, so the command still runs.
				expect(fixture.client.permissionRequests.length, "permission requests").toBe(1)
				expect(existsSync(join(fixture.workDir, "hello.pdf")), "artifact created").toBe(true)
			} finally {
				await fixture.stop()
			}
		})
	},
	STARTUP_TIMEOUT_MS,
)

/** Plan mode: a read verb runs without a round-trip (plan_readonly), and the
 *  completed tool_call_update carries the document text — proof the route
 *  executed rather than silently doing nothing. */
it(
	"plan mode runs read-only doc-cli verbs without a permission round-trip (ACP)",
	async () => {
		await withDocCliEnv("plan", async () => {
			// Pre-create the PDF with the built binary itself — the harness
			// invokes it directly, outside the session's permission system.
			// The marker is a single unbreakable token: the PDF renderer
			// wraps prose at the page width, so a sentence marker can break
			// across lines and fail a substring match.
			const marker = "PLANMODE_MARKER_X7F391"
			const fixture = await startAcpFixture({
				artifactName: "doc-cli-plan-read",
				responses: [
					{
						toolCalls: [
							{
								id: "call_doccli_read",
								function: {
									name: "bash",
									arguments: JSON.stringify({ command: "kimchi doc-cli pdf read hello.pdf" }),
								},
							},
						],
					},
					{ stream: ["Read done."] },
				],
			})
			try {
				writeFileSync(join(fixture.workDir, "hello.md"), `# ${marker}\n`)
				execFileSync(join(binaryDir, "kimchi"), ["doc-cli", "pdf", "create", "hello.pdf", "--content", "hello.md"], {
					cwd: fixture.workDir,
				})
				const sessionId = await newSession(fixture, fixture.workDir)
				// The turn is not awaited to completion: the bash-background
				// exit-collection can re-emit a finished command's output
				// without settling the tool on slow runners (a pre-existing
				// race in that subsystem, see bash-cancellation-settlement) —
				// the permission contract is fully proven once the read's
				// output has arrived with no permission round-trip.
				const settled = prompt(fixture, sessionId, "Read the PDF").catch(() => undefined)

				await waitForSessionUpdate(
					fixture,
					sessionId,
					(u) => u.sessionUpdate === "tool_call_update" && JSON.stringify(u).includes(marker),
				)
				expect(fixture.client.permissionRequests).toEqual([])
				void settled
			} finally {
				await fixture.stop()
			}
		})
	},
	STARTUP_TIMEOUT_MS,
)

/** Plan mode: a mutating verb is rejected by the plan gate — the tool result
 *  carries the block reason, and no permission request crosses the wire (plan
 *  mode never prompts). */
it(
	"plan mode blocks mutating doc-cli verbs without a permission round-trip (ACP)",
	async () => {
		await withDocCliEnv("plan", async () => {
			const { fixture, sessionId } = await driveDocCliCreate("doc-cli-plan-blocks-create")
			try {
				await waitForSessionUpdate(
					fixture,
					sessionId,
					(u) => u.sessionUpdate === "tool_call_update" && JSON.stringify(u).includes("plan mode"),
				)
				expect(fixture.client.permissionRequests).toEqual([])
				expect(existsSync(join(fixture.workDir, "hello.pdf")), "artifact not created").toBe(false)
			} finally {
				await fixture.stop()
			}
		})
	},
	STARTUP_TIMEOUT_MS,
)
