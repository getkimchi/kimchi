import { describe, expect, it, vi } from "vitest"
import type { RemoteSessionMeta } from "./manager/remote-agent-runner.js"
import { findResumableRemoteRuns, persistRemoteRunState, type RemoteRunState } from "./remote-run-persistence.js"

const META: RemoteSessionMeta = {
	workspaceId: "ws-1",
	sessionName: "acp-resume01",
	wsUrl: "wss://worker.example.com",
	host: "worker.example.com",
	cwd: "/home/sandbox/acp-resume01",
}

function makeState(overrides: Partial<RemoteRunState> = {}): RemoteRunState {
	return {
		id: "agent-1",
		description: "cloud: test plan",
		remoteSession: META,
		acpSessionId: "remote-acp-1",
		remoteOrigin: "plan",
		startedAt: 1_000,
		status: "running",
		...overrides,
	}
}

/** Custom-entry shape as read back from the session branch. */
function entry(data: RemoteRunState, extra: Record<string, unknown> = {}) {
	return { type: "custom", customType: "remote_run:state", data, ...extra }
}

describe("persistRemoteRunState", () => {
	it("appends a remote_run:state custom entry with the full state", () => {
		const appendEntry = vi.fn()
		const state = makeState()

		persistRemoteRunState({ appendEntry }, state)

		expect(appendEntry).toHaveBeenCalledWith("remote_run:state", state)
	})
})

describe("findResumableRemoteRuns", () => {
	it("returns only non-terminal remote runs; the last entry per id wins", () => {
		const branch = [
			{ type: "message", role: "user" }, // noise: not a custom entry
			entry(makeState({ id: "agent-1" })),
			{ type: "custom", customType: "subagents:record", data: { id: "other" } }, // noise: other custom type
			entry(makeState({ id: "agent-2", status: "completed" })), // terminal — skipped
			entry(makeState({ id: "agent-1", status: "error" })), // terminal overrides the running entry for agent-1
			entry(makeState({ id: "agent-3", description: "cloud: another" })),
		]

		const resumable = findResumableRemoteRuns({ getBranch: () => branch })

		// agent-1's later "error" entry wins — not resumable. agent-3 still runs.
		expect(resumable).toHaveLength(1)
		expect(resumable[0]?.id).toBe("agent-3")
	})

	it("skips entries without the full reattach metadata (older or corrupt data)", () => {
		const branch = [
			entry({ ...makeState(), acpSessionId: undefined as unknown as string }),
			entry({ ...makeState({ id: "agent-2" }), remoteSession: undefined as unknown as RemoteSessionMeta }),
		]

		expect(findResumableRemoteRuns({ getBranch: () => branch })).toHaveLength(0)
	})

	it("returns an empty list for a session without remote entries", () => {
		expect(findResumableRemoteRuns({ getBranch: () => [] })).toEqual([])
	})
})
