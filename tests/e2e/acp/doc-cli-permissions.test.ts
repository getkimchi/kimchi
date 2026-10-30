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
async function withDocCliEnv(mode: undefined | "auto", run: () => Promise<void>): Promise<void> {
	const prevPermissions = process.env.KIMCHI_PERMISSIONS
	const prevPath = process.env.PATH
	if (mode === "auto") process.env.KIMCHI_PERMISSIONS = "auto"
	process.env.PATH = `${binaryDir}${delimiter}${process.env.PATH ?? ""}`
	try {
		await run()
	} finally {
		if (prevPermissions === undefined) Reflect.deleteProperty(process.env, "KIMCHI_PERMISSIONS")
		else process.env.KIMCHI_PERMISSIONS = prevPermissions
		process.env.PATH = prevPath
	}
}

async function driveDocCliCreate(artifactName: string): Promise<Awaited<ReturnType<typeof startAcpFixture>>> {
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
	return fixture
}

it(
	"auto mode runs doc-cli with no permission round-trip (ACP)",
	async () => {
		await withDocCliEnv("auto", async () => {
			const fixture = await driveDocCliCreate("doc-cli-auto-allow")
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
			const fixture = await driveDocCliCreate("doc-cli-default-prompts")
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
