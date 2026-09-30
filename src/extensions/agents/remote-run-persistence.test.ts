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

describe("gitWorkflow persistence", () => {
	/** Simulates append-to-transcript → restart → read-back: structured data
	 *  crosses JSON, so undefined-valued keys disappear. */
	function jsonRoundTrip<T>(value: T): T {
		return JSON.parse(JSON.stringify(value))
	}

	it("round-trips the git intent + baseline through persist and resume", () => {
		const gitWorkflow = {
			branch: "kimchi/build-feature",
			baseBranch: "main",
			baseSha: "0123456789abcdef0123456789abcdef01234567",
			dirtyFiles: ["src/dirty.ts", "notes.md"],
		}
		const state = makeState({ gitWorkflow })
		const appendEntry = vi.fn()

		persistRemoteRunState({ appendEntry }, state)

		const persistedData = jsonRoundTrip(appendEntry.mock.calls[0]?.[1] as RemoteRunState)
		const resumed = findResumableRemoteRuns({ getBranch: () => [entry(persistedData)] })
		expect(resumed).toHaveLength(1)
		expect(resumed[0]?.gitWorkflow).toEqual(gitWorkflow)
	})

	it("keeps legacy entries without gitWorkflow parseable and resumable", () => {
		const legacyData = jsonRoundTrip(makeState())
		expect("gitWorkflow" in legacyData).toBe(false)

		const resumed = findResumableRemoteRuns({ getBranch: () => [entry(legacyData)] })
		expect(resumed).toHaveLength(1)
		expect(resumed[0]?.gitWorkflow).toBeUndefined()
	})

	it("drops an undefined baseBranch on the JSON round trip but keeps the branch", () => {
		const state = makeState({ gitWorkflow: { branch: "kimchi/x", baseBranch: undefined } })
		const persistedData = jsonRoundTrip(state)
		expect(persistedData.gitWorkflow).toEqual({ branch: "kimchi/x" })
		expect("baseBranch" in (persistedData.gitWorkflow ?? {})).toBe(false)
	})

	it("round-trips an intent captured before baseline exists (baseSha/dirtyFiles absent)", () => {
		const state = makeState({ gitWorkflow: { branch: "kimchi/x", baseBranch: "main" } })
		const resumed = findResumableRemoteRuns({ getBranch: () => [entry(jsonRoundTrip(state))] })
		expect(resumed[0]?.gitWorkflow).toEqual({ branch: "kimchi/x", baseBranch: "main" })
		expect(resumed[0]?.gitWorkflow?.baseSha).toBeUndefined()
		expect(resumed[0]?.gitWorkflow?.dirtyFiles).toBeUndefined()
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
