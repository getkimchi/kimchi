import type * as Fs from "node:fs"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { hasOwnedWorkReference } from "./continuation.js"
import type { WorkRecord } from "./summary.js"

vi.mock("node:fs", async (original) => {
	const actual = await original<typeof Fs>()
	return { ...actual, realpathSync: Object.assign(vi.fn(actual.realpathSync), { native: actual.realpathSync.native }) }
})

const workId = "11111111-1111-4111-8111-111111111111"
let cwd: string
beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-owned-reference-")))
	mkdirSync(join(cwd, "docs"))
	mkdirSync(join(cwd, "other"))
})
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true })
})
function row(type: "plan" | "file_transition", fields: Record<string, unknown>): WorkRecord {
	return { version: 1, type, workId, sessionId: "planner", ...fields }
}

it.each([
	["an unowned file", () => [], false],
	[
		"a file with the same name in another directory",
		() => [row("file_transition", { worktree: cwd, path: "other/adr.md" })],
		false,
	],
	["an edited file", () => [row("file_transition", { worktree: cwd, path: "docs/adr.md" })], true],
	["a plan's editable path", () => [row("plan", { cwd, path: "docs/adr.md" })], true],
	["a plan's retained path", () => [row("plan", { cwd, path: "gone.md", snapshotPath: "docs/adr.md" })], true],
] as const)("finds whether a mention of %s has an owner", (_case, records, owned) => {
	expect(hasOwnedWorkReference({ cwd }, "Implement docs/adr.md", records())).toBe(owned)
})

it("matches an owner through a directory alias", () => {
	symlinkSync(join(cwd, "docs"), join(cwd, "alias"), "dir")
	const records = [row("file_transition", { worktree: cwd, path: "docs/adr.md" })]
	expect(hasOwnedWorkReference({ cwd }, "Implement alias/adr.md", records)).toBe(true)
})

it("resolves only the journal rows that name a mentioned file", () => {
	const unrelated = Array.from({ length: 200 }, (_, index) => [
		row("file_transition", { worktree: cwd, path: `docs/other-${index}.md` }),
		row("plan", { cwd, path: `.kimchi/plans/plan-${index}.md`, snapshotPath: `/retained/plan-${index}.md` }),
	]).flat()
	const owner = row("file_transition", { worktree: cwd, path: "docs/adr.md" })
	vi.mocked(realpathSync).mockClear()
	expect(hasOwnedWorkReference({ cwd }, "Implement docs/adr.md", [...unrelated, owner])).toBe(true)
	// One call for the mention itself and one for its owner's row.
	expect(realpathSync).toHaveBeenCalledTimes(2)
})
