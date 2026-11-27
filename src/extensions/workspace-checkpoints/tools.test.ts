import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createToolContext } from "../__mocks__/context.js"
import { CheckpointStore } from "./store.js"
import { workspaceCheckpointTool } from "./tools.js"

const execFileAsync = promisify(execFile)
let dir: string
let repo: string
let store: CheckpointStore

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-checkpoint-tools-"))
	repo = join(dir, "work")
	mkdirSync(repo, { recursive: true })
	writeFileSync(join(repo, "source.txt"), "original\n")
	await execFileAsync("git", ["init", "-q"], { cwd: repo })
	await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo })
	await execFileAsync("git", ["config", "user.email", "test@local"], { cwd: repo })
	await execFileAsync("git", ["add", "source.txt"], { cwd: repo })
	await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: repo })
	store = await CheckpointStore.open({ cwd: repo, stateDir: join(dir, "state"), sessionId: "tools-session" })
})

afterEach(() => rmSync(dir, { force: true, recursive: true }))

function checkpointId(result: unknown, kind: "checkpoint" | "safetyCheckpoint" = "checkpoint"): string {
	if (
		typeof result !== "object" ||
		result === null ||
		!("details" in result) ||
		typeof result.details !== "object" ||
		result.details === null
	) {
		throw new Error("Expected checkpoint metadata")
	}
	const checkpoint = Object.getOwnPropertyDescriptor(result.details, kind)?.value
	if (
		typeof checkpoint !== "object" ||
		checkpoint === null ||
		!("id" in checkpoint) ||
		typeof checkpoint.id !== "string"
	) {
		throw new Error("Expected checkpoint metadata with a string id")
	}
	return checkpoint.id
}

describe("workspace_checkpoint tool", () => {
	it("saves labeled candidates, lists them, and deliberately restores selection", async () => {
		const ctx = createToolContext({ cwd: repo })
		const tool = workspaceCheckpointTool(async () => store)
		const saved = await tool.execute(
			"save",
			{ action: "save", label: "validated candidate", validated: true },
			undefined,
			undefined,
			ctx,
		)
		expect(JSON.stringify(saved)).toContain("Validated claim: true")
		const id = checkpointId(saved)
		writeFileSync(join(repo, "source.txt"), "regressed\n")
		const listed = await tool.execute("list", { action: "list" }, undefined, undefined, ctx)
		expect(JSON.stringify(listed)).toContain(id)
		const restored = await tool.execute("restore", { action: "restore", id }, undefined, undefined, ctx)
		expect(JSON.stringify(restored)).toContain("Restored paths: 1")
		expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("original\n")
		const safety = checkpointId(restored, "safetyCheckpoint")
		expect(safety).not.toBe(id)
		expect((await store.get(safety))?.trigger).toBe("before-restore")
	})

	it("requires a checkpoint id for restore", async () => {
		const tool = workspaceCheckpointTool(async () => store)
		await expect(
			tool.execute("call", { action: "restore" }, undefined, undefined, createToolContext({ cwd: repo })),
		).rejects.toThrow("id is required")
	})
})
