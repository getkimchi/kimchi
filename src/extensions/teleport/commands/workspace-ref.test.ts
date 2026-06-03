import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { listWorkspacesMock, pickWorkspaceMock } = vi.hoisted(() => ({
	listWorkspacesMock: vi.fn(),
	pickWorkspaceMock: vi.fn(),
}))

vi.mock("../../../sandbox/cloud/workspaces.js", () => ({ listWorkspaces: listWorkspacesMock }))
vi.mock("../ui/workspaces-panel.js", () => ({ pickWorkspace: pickWorkspaceMock }))

import type { Workspace } from "../../../sandbox/cloud/types.js"
import type { TeleportContext } from "../types.js"
import { TeleportRefusal } from "./errors.js"
import { isUuid, leftmostLabel, matchesHostNickname, resolveWorkspaceRef } from "./workspace-ref.js"

const UUID_A = "11111111-1111-4111-8111-111111111111"
const UUID_B = "22222222-2222-4222-8222-222222222222"

function makeUi(): ExtensionUIContext & { notify: ReturnType<typeof vi.fn> } {
	return {
		notify: vi.fn(),
		setStatus: vi.fn(),
		setHeader: vi.fn(),
		setWidget: vi.fn(),
		setTitle: vi.fn(),
		setEditorText: vi.fn(),
		setWorkingMessage: vi.fn(),
		setWorkingVisible: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		setFooter: vi.fn(),
		setEditorComponent: vi.fn(),
		getEditorComponent: vi.fn(),
		getEditorText: vi.fn(),
		pasteToEditor: vi.fn(),
		select: vi.fn(),
		confirm: vi.fn(),
		input: vi.fn(),
		editor: vi.fn(),
		onTerminalInput: vi.fn(() => vi.fn()),
		addAutocompleteProvider: vi.fn(),
		custom: vi.fn(),
		theme: {} as never,
		getAllThemes: vi.fn(() => []),
		getTheme: vi.fn(),
		setTheme: vi.fn(() => ({ success: true })),
		getToolsExpanded: vi.fn(() => false),
		setToolsExpanded: vi.fn(),
	} as unknown as ExtensionUIContext & { notify: ReturnType<typeof vi.fn> }
}

function makeCtx(): { ctx: TeleportContext; ui: ReturnType<typeof makeUi> } {
	const ui = makeUi()
	const ctx: TeleportContext = {
		apiKey: "test-key",
		endpoint: "https://api.example.com",
		cwd: "/work/proj",
		ui,
		signal: undefined,
	}
	return { ctx, ui }
}

function ws(over: Partial<Workspace> = {}): Workspace {
	return {
		id: UUID_A,
		name: "kimchi-dev",
		createdAt: new Date(),
		lastActivityAt: new Date(),
		status: "active",
		host: "trusting-ruling-frontier-486e4e-abbf.remote.kimchi.dev",
		...over,
	}
}

beforeEach(() => {
	listWorkspacesMock.mockReset().mockResolvedValue([])
	pickWorkspaceMock.mockReset()
})

describe("isUuid", () => {
	it("accepts canonical v4", () => {
		expect(isUuid(UUID_A)).toBe(true)
		expect(isUuid("9266c03d-c8f3-484b-83b9-d42fe62e8f46")).toBe(true)
	})
	it("rejects garbage", () => {
		expect(isUuid("")).toBe(false)
		expect(isUuid("w-explicit")).toBe(false)
		expect(isUuid("11111111-1111-1111-1111-11111111111")).toBe(false)
		expect(isUuid("11111111-1111-4111-8111-1111111111111")).toBe(false)
		expect(isUuid("ZZZZZZZZ-1111-4111-8111-111111111111")).toBe(false)
	})
})

describe("leftmostLabel", () => {
	it("returns segment before first dot", () => {
		expect(leftmostLabel("a.b.c")).toBe("a")
		expect(leftmostLabel("trusting-ruling-frontier-abbf.remote.kimchi.dev")).toBe("trusting-ruling-frontier-abbf")
	})
	it("returns the whole string when no dot", () => {
		expect(leftmostLabel("single")).toBe("single")
	})
	it("returns undefined for undefined or empty", () => {
		expect(leftmostLabel(undefined)).toBeUndefined()
		expect(leftmostLabel("")).toBeUndefined()
	})
})

describe("matchesHostNickname", () => {
	const HOST = "trusting-ruling-frontier-486e4e-abbf.remote.kimchi.dev"

	it("accepts token-bounded prefixes", () => {
		expect(matchesHostNickname(HOST, "trusting")).toBe(true)
		expect(matchesHostNickname(HOST, "trusting-ruling")).toBe(true)
		expect(matchesHostNickname(HOST, "trusting-ruling-frontier")).toBe(true)
		expect(matchesHostNickname(HOST, "trusting-ruling-frontier-486e4e-abbf")).toBe(true)
	})

	it("rejects sub-token prefixes and non-prefix substrings", () => {
		expect(matchesHostNickname(HOST, "trust")).toBe(false)
		expect(matchesHostNickname(HOST, "frontier")).toBe(false)
		expect(matchesHostNickname(HOST, "ruling")).toBe(false)
		expect(matchesHostNickname(HOST, "trusting-rul")).toBe(false)
	})

	it("is case-insensitive", () => {
		expect(matchesHostNickname(HOST, "TRUSTING-RULING")).toBe(true)
	})

	it("returns false for undefined host or empty ref", () => {
		expect(matchesHostNickname(undefined, "trusting")).toBe(false)
		expect(matchesHostNickname(HOST, "")).toBe(false)
	})
})

describe("resolveWorkspaceRef", () => {
	it("returns {id, name} when a UUID ref matches a known workspace", async () => {
		listWorkspacesMock.mockResolvedValue([ws({ id: UUID_A, name: "kimchi-dev" })])
		const { ctx } = makeCtx()
		const resolved = await resolveWorkspaceRef(ctx, UUID_A, { onEmpty: { kind: "mint" } })
		expect(resolved).toEqual({ id: UUID_A, name: "kimchi-dev" })
		expect(listWorkspacesMock).toHaveBeenCalledOnce()
	})

	it("returns id with no name when UUID ref is not in the list (server stale/paginated)", async () => {
		listWorkspacesMock.mockResolvedValue([ws({ id: UUID_B, name: "other" })])
		const { ctx } = makeCtx()
		const resolved = await resolveWorkspaceRef(ctx, UUID_A, { onEmpty: { kind: "mint" } })
		expect(resolved).toEqual({ id: UUID_A })
	})

	it("resolves a unique name match (case-insensitive) with the workspace's stored name", async () => {
		listWorkspacesMock.mockResolvedValue([ws({ id: UUID_A, name: "kimchi-dev" })])
		const { ctx } = makeCtx()
		const resolved = await resolveWorkspaceRef(ctx, "KIMCHI-DEV", { onEmpty: { kind: "mint" } })
		expect(resolved).toEqual({ id: UUID_A, name: "kimchi-dev" })
	})

	it("resolves a unique host-nickname prefix match", async () => {
		listWorkspacesMock.mockResolvedValue([ws({ id: UUID_A, name: "other-name" })])
		const { ctx } = makeCtx()
		const resolved = await resolveWorkspaceRef(ctx, "trusting-ruling", { onEmpty: { kind: "mint" } })
		expect(resolved).toEqual({ id: UUID_A, name: "other-name" })
	})

	it("treats name+nickname collision on the same workspace as a single match", async () => {
		listWorkspacesMock.mockResolvedValue([ws({ id: UUID_A, name: "trusting-ruling" })])
		const { ctx } = makeCtx()
		const resolved = await resolveWorkspaceRef(ctx, "trusting-ruling", { onEmpty: { kind: "mint" } })
		expect(resolved.id).toBe(UUID_A)
	})

	it("refuses with disambiguation when ref hits two different workspaces", async () => {
		listWorkspacesMock.mockResolvedValue([
			ws({ id: UUID_A, name: "kimchi-dev", host: "alpha-foo.remote.kimchi.dev" }),
			ws({ id: UUID_B, name: "other", host: "kimchi-dev-x.remote.kimchi.dev" }),
		])
		const { ctx, ui } = makeCtx()
		await expect(resolveWorkspaceRef(ctx, "kimchi-dev", { onEmpty: { kind: "mint" } })).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
		const msg = ui.notify.mock.calls[0]?.[0] as string
		expect(msg).toMatch(/ambiguous/i)
		expect(msg).toContain(UUID_A)
		expect(msg).toContain(UUID_B)
	})

	it("refuses with disambiguation when two workspaces share the same host-nickname prefix", async () => {
		listWorkspacesMock.mockResolvedValue([
			ws({ id: UUID_A, name: "a", host: "trusting-ruling-frontier-x.remote.kimchi.dev" }),
			ws({ id: UUID_B, name: "b", host: "trusting-ruling-otter-y.remote.kimchi.dev" }),
		])
		const { ctx, ui } = makeCtx()
		await expect(resolveWorkspaceRef(ctx, "trusting-ruling", { onEmpty: { kind: "mint" } })).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
		const msg = ui.notify.mock.calls[0]?.[0] as string
		expect(msg).toMatch(/ambiguous/i)
	})

	it("refuses with 'no workspace matching' when ref matches nothing", async () => {
		listWorkspacesMock.mockResolvedValue([ws({ name: "something-else" })])
		const { ctx, ui } = makeCtx()
		await expect(resolveWorkspaceRef(ctx, "bogus", { onEmpty: { kind: "mint" } })).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/No workspace matching "bogus"/), "error")
	})

	it("mints a new id (no name) when no ref, no workspaces (onEmpty=mint)", async () => {
		const { ctx } = makeCtx()
		const resolved = await resolveWorkspaceRef(ctx, undefined, { onEmpty: { kind: "mint" } })
		expect(resolved.id).toMatch(/^[0-9a-f-]{36}$/i)
		expect(resolved.name).toBeUndefined()
	})

	it("refuses when no ref, no workspaces (onEmpty=refuse)", async () => {
		const { ctx, ui } = makeCtx()
		await expect(
			resolveWorkspaceRef(ctx, undefined, { onEmpty: { kind: "refuse", message: "no ws" } }),
		).rejects.toBeInstanceOf(TeleportRefusal)
		expect(ui.notify).toHaveBeenCalledWith("no ws", "error")
	})

	it("opens the picker when no ref but workspaces exist; returns the chosen id+name", async () => {
		listWorkspacesMock.mockResolvedValue([ws({ id: UUID_A, name: "picked-one" })])
		pickWorkspaceMock.mockResolvedValue({ action: "select", row: { id: UUID_A } })
		const { ctx } = makeCtx()
		const resolved = await resolveWorkspaceRef(ctx, undefined, { onEmpty: { kind: "mint" } })
		expect(resolved).toEqual({ id: UUID_A, name: "picked-one" })
	})

	it("picker is opened with allowNew=true when onEmpty.kind === 'mint'", async () => {
		listWorkspacesMock.mockResolvedValue([ws({ id: UUID_A })])
		pickWorkspaceMock.mockResolvedValue({ action: "select", row: { id: UUID_A } })
		const { ctx } = makeCtx()
		await resolveWorkspaceRef(ctx, undefined, { onEmpty: { kind: "mint" } })
		expect(pickWorkspaceMock).toHaveBeenCalledOnce()
		expect(pickWorkspaceMock.mock.calls[0][2]).toMatchObject({ allowNew: true, hideSessions: true })
	})

	it("picker is opened with allowNew=false when onEmpty.kind === 'refuse'", async () => {
		listWorkspacesMock.mockResolvedValue([ws({ id: UUID_A })])
		pickWorkspaceMock.mockResolvedValue({ action: "select", row: { id: UUID_A } })
		const { ctx } = makeCtx()
		await resolveWorkspaceRef(ctx, undefined, { onEmpty: { kind: "refuse", message: "nope" } })
		expect(pickWorkspaceMock.mock.calls[0][2]).toMatchObject({ allowNew: false, hideSessions: true })
	})

	it("picker 'new' with onEmpty=mint → fresh id, no name", async () => {
		listWorkspacesMock.mockResolvedValue([ws({ id: UUID_A })])
		pickWorkspaceMock.mockResolvedValue({ action: "new" })
		const { ctx } = makeCtx()
		const resolved = await resolveWorkspaceRef(ctx, undefined, { onEmpty: { kind: "mint" } })
		expect(resolved.id).toMatch(/^[0-9a-f-]{36}$/i)
		expect(resolved.id).not.toBe(UUID_A)
		expect(resolved.name).toBeUndefined()
	})

	it("picker cancelled → TeleportRefusal('cancelled')", async () => {
		listWorkspacesMock.mockResolvedValue([ws({ id: UUID_A })])
		pickWorkspaceMock.mockResolvedValue(undefined)
		const { ctx } = makeCtx()
		await expect(resolveWorkspaceRef(ctx, undefined, { onEmpty: { kind: "mint" } })).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
	})
})
