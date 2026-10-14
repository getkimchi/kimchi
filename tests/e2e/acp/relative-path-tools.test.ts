// ACP integration: relative tool paths resolve against the session cwd.
//
// The ACP server is a long-lived process whose own working directory is
// unrelated to any session. Tool arguments with relative paths must therefore
// resolve against `ExtensionContext.cwd` (from session/new), not process.cwd().
// Before the fix, relative `read`/`grep`/`find`/`ls`/`write`/`edit` calls
// resolved against the harness process cwd and failed with ENOENT even though
// the files existed in the session's project root.
//
// File and content names carry a unique token so "ENOENT in the harness cwd"
// can never produce a false positive: no such files exist over there.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const TOKEN = "rpacpmarker7f3d"

function toolCall(name: string, args: Record<string, unknown>): { function: { name: string; arguments: string } } {
	return { function: { name, arguments: JSON.stringify(args) } }
}

interface ToolStep {
	readonly tool: string
	readonly args: Record<string, unknown>
	/** Substring the serialized tool updates for this step must contain. */
	readonly expectContains?: string
	/** Extra assertion run after the prompt completes (e.g. on-disk state). */
	readonly verify?: () => void
}

describe("ACP integration — relative tool paths resolve against session cwd", () => {
	let fixture: AcpFixture
	let createdFile: string
	let editableFile: string

	const steps: ToolStep[] = [
		{ tool: "read", args: { path: `${TOKEN}.txt` }, expectContains: `${TOKEN}-content` },
		{ tool: "ls", args: { path: TOKEN }, expectContains: `nested-${TOKEN}.txt` },
		{ tool: "grep", args: { pattern: `${TOKEN}-needle`, path: TOKEN }, expectContains: `${TOKEN}-needle` },
		{ tool: "find", args: { pattern: `*${TOKEN}.md` }, expectContains: `${TOKEN}.md` },
		{
			tool: "write",
			args: { path: `${TOKEN}-created/out.txt`, content: `${TOKEN}-written` },
			verify: () => {
				expect(readFileSync(createdFile, "utf-8")).toBe(`${TOKEN}-written`)
			},
		},
		{
			tool: "edit",
			args: {
				path: `${TOKEN}-edit.txt`,
				edits: [{ oldText: `${TOKEN}-before`, newText: `${TOKEN}-after` }],
			},
			expectContains: `${TOKEN}-after`,
			verify: () => {
				expect(readFileSync(editableFile, "utf-8").trim()).toBe(`${TOKEN}-after`)
			},
		},
	]

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "relative-path-tools",
			// After each tool call executes, the loop calls the model again — script a plain
			// text finish for that call so the next tool call lines up with the next prompt.
			responses: steps.flatMap((s) => [
				{ stream: [`Running ${s.tool}.`], toolCalls: [toolCall(s.tool, s.args)] },
				{ stream: [`Finished ${s.tool}.`] },
			]),
		})
		writeFileSync(join(fixture.workDir, `${TOKEN}.txt`), `${TOKEN}-content\n`)
		mkdirSync(join(fixture.workDir, TOKEN), { recursive: true })
		writeFileSync(join(fixture.workDir, TOKEN, `nested-${TOKEN}.txt`), `${TOKEN}-needle\n`)
		writeFileSync(join(fixture.workDir, `${TOKEN}.md`), "# doc\n")
		editableFile = join(fixture.workDir, `${TOKEN}-edit.txt`)
		writeFileSync(editableFile, `${TOKEN}-before\n`)
		createdFile = join(fixture.workDir, `${TOKEN}-created`, "out.txt")
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("resolves read, ls, grep, find, write and edit against the session workdir", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		let updateCountBefore = fixture.client.sessionUpdates.length

		for (const step of steps) {
			const result = await prompt(fixture, sessionId, `Run ${step.tool}`)
			expect(result.stopReason, `${step.tool} turn stop reason`).toBe("end_turn")

			const updates = fixture.client.sessionUpdates
				.slice(updateCountBefore)
				.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call_update")
			updateCountBefore = fixture.client.sessionUpdates.length

			expect(updates.length, `tool_call_update present for ${step.tool}`).toBeGreaterThanOrEqual(1)
			const serialized = JSON.stringify(updates)
			if (step.expectContains !== undefined) {
				expect(serialized, `${step.tool} result contains expected content`).toContain(step.expectContains)
			}
			expect(serialized, `${step.tool} result is not an ENOENT failure`).not.toContain("ENOENT")
			step.verify?.()
		}
	})
})
