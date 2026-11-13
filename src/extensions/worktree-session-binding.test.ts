import { afterEach, describe, expect, it } from "vitest"
import { KIMCHI_WORKTREE_ENV, KIMCHI_WORKTREE_MAIN_ENV } from "../worktree-cli.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import {
	createWorktreeSessionBindingExtension,
	isUserNamedWorktree,
	KIMCHI_WORKTREE_ENTRY_TYPE,
	readWorktreeBindingFromEnv,
} from "./worktree-session-binding.js"

describe("readWorktreeBindingFromEnv", () => {
	it("returns undefined without the worktree env vars", () => {
		expect(readWorktreeBindingFromEnv({})).toBeUndefined()
		expect(readWorktreeBindingFromEnv({ PATH: "/usr/bin" })).toBeUndefined()
	})

	it("returns undefined when only one of the pair is set", () => {
		expect(readWorktreeBindingFromEnv({ [KIMCHI_WORKTREE_ENV]: "/repo/.kimchi/worktrees/feat-x" })).toBeUndefined()
		expect(readWorktreeBindingFromEnv({ [KIMCHI_WORKTREE_MAIN_ENV]: "/repo" })).toBeUndefined()
	})

	it("resolves the binding from both env vars", () => {
		const dir = "/repo/.kimchi/worktrees/feat-x"
		const mainRoot = "/repo"
		const entry = readWorktreeBindingFromEnv({
			[KIMCHI_WORKTREE_ENV]: dir,
			[KIMCHI_WORKTREE_MAIN_ENV]: mainRoot,
		})
		expect(entry).toMatchObject({
			schemaVersion: 1,
			dir,
			mainRoot,
			branch: "worktree-feat-x",
			name: "feat-x",
			named: true,
		})
	})

	it("marks auto-generated names as unnamed", () => {
		const entry = readWorktreeBindingFromEnv({
			[KIMCHI_WORKTREE_ENV]: "/repo/.kimchi/worktrees/bold-oak-a3f2",
			[KIMCHI_WORKTREE_MAIN_ENV]: "/repo",
		})
		expect(entry?.named).toBe(false)
	})
})

describe("isUserNamedWorktree", () => {
	it("treats adjective-noun-hex names as generated, everything else as user-named", () => {
		expect(isUserNamedWorktree("bold-oak-a3f2")).toBe(false)
		expect(isUserNamedWorktree("swift-river-00ff")).toBe(false)
		expect(isUserNamedWorktree("feature-x")).toBe(true)
		expect(isUserNamedWorktree("feat/worktree")).toBe(true)
		expect(isUserNamedWorktree("agent-abc1234-my-slug")).toBe(true)
	})
})

describe("createWorktreeSessionBindingExtension", () => {
	afterEach(() => {
		for (const key of [KIMCHI_WORKTREE_ENV, KIMCHI_WORKTREE_MAIN_ENV]) delete process.env[key]
	})

	it("skips the append when there is no worktree binding", async () => {
		const { api, emit } = createExtensionApi()
		const extension = createWorktreeSessionBindingExtension(() => undefined)
		extension(api as never)
		await emit("session_start", {})
		expect(api.appendEntry).not.toHaveBeenCalled()
	})

	it("appends a kimchi_worktree entry at session_start with the resolved binding", async () => {
		process.env[KIMCHI_WORKTREE_ENV] = "/repo/.kimchi/worktrees/feat-x"
		process.env[KIMCHI_WORKTREE_MAIN_ENV] = "/repo"
		const { api, emit, getAppendedEntries } = createExtensionApi()
		const extension = createWorktreeSessionBindingExtension()
		extension(api as never)
		await emit("session_start", {})
		const entries = getAppendedEntries<Record<string, unknown>>(KIMCHI_WORKTREE_ENTRY_TYPE)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({
			schemaVersion: 1,
			dir: "/repo/.kimchi/worktrees/feat-x",
			mainRoot: "/repo",
			branch: "worktree-feat-x",
			name: "feat-x",
			named: true,
		})
	})

	it("uses the injected resolver when provided (no env dependency)", async () => {
		const { api, emit, getAppendedEntries } = createExtensionApi()
		const resolver = () => ({
			schemaVersion: 1 as const,
			dir: "/main/.kimchi/worktrees/agent-run-1",
			mainRoot: "/main",
			branch: "worktree-agent-run-1",
			name: "agent-run-1",
			named: false,
		})
		const extension = createWorktreeSessionBindingExtension(resolver)
		extension(api as never)
		await emit("session_start", {})
		const entries = getAppendedEntries(KIMCHI_WORKTREE_ENTRY_TYPE)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ name: "agent-run-1", named: false })
	})

	it("holds session_shutdown until the pending append settles", async () => {
		process.env[KIMCHI_WORKTREE_ENV] = "/repo/.kimchi/worktrees/feat-x"
		process.env[KIMCHI_WORKTREE_MAIN_ENV] = "/repo"
		const { api, emit } = createExtensionApi()
		const extension = createWorktreeSessionBindingExtension()
		extension(api as never)
		await emit("session_start", {})
		await emit("session_shutdown", { reason: "quit" })
		expect(api.appendEntry).toHaveBeenCalledTimes(1)
	})
})
