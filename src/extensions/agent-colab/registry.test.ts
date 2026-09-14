import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
	agentDirFromSessionFile,
	listLivePeers,
	type PeerRecord,
	parsePeerRecord,
	peerLabel,
	peerStateDir,
	readPeerName,
	registerPeer,
	removePeer,
	resolvePeer,
	writePeerName,
} from "./registry.js"

let dir: string

function makeRecord(overrides: Partial<PeerRecord> = {}): PeerRecord {
	return {
		sessionId: "019f1111-1111-7111-8111-111111111111",
		pid: process.pid,
		port: 41234,
		token: "tok-abc",
		name: "alpha",
		cwd: "/tmp/work",
		startedAt: new Date().toISOString(),
		...overrides,
	}
}

// A pid that has already exited: spawn `true` synchronously.
function deadPid(): number {
	const child = spawnSync("true")
	return child.pid ?? 999_999_999
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-colab-registry-"))
})

describe("peer registry", () => {
	it("registers, reads, and removes records", () => {
		const record = makeRecord()
		registerPeer(dir, record)
		expect(existsSync(join(dir, `${record.sessionId}.json`))).toBe(true)

		const read = listLivePeers(dir)
		expect(read).toHaveLength(1)
		expect(read[0].record.token).toBe("tok-abc")
		expect(read[0].alive).toBe(true)

		removePeer(dir, record.sessionId)
		expect(listLivePeers(dir)).toHaveLength(0)
	})

	it("writeFileSync result is user-only (0600)", () => {
		const record = makeRecord()
		registerPeer(dir, record)
		const mode = statSync(join(dir, `${record.sessionId}.json`)).mode & 0o777
		expect(mode).toBe(0o600)
	})

	it("prunes dead-pid records on read", () => {
		const record = makeRecord({ pid: deadPid() })
		registerPeer(dir, record)
		expect(listLivePeers(dir)).toHaveLength(0)
		expect(existsSync(join(dir, `${record.sessionId}.json`))).toBe(false)
	})

	it("skips malformed and mismatched records", () => {
		writeFileSync(join(dir, "bad.json"), "{not json")
		writeFileSync(join(dir, "mismatch.json"), JSON.stringify({ ...makeRecord({ sessionId: "other" }) }))
		writeFileSync(join(dir, "badport.json"), JSON.stringify(makeRecord({ port: 99_999 })))
		registerPeer(dir, makeRecord())
		const live = listLivePeers(dir)
		expect(live).toHaveLength(1)
		expect(live[0].record.name).toBe("alpha")
	})

	it("parsePeerRecord rejects structurally invalid input", () => {
		expect(parsePeerRecord(null, "x")).toBeUndefined()
		expect(parsePeerRecord({ sessionId: "x" }, "x")).toBeUndefined()
		expect(parsePeerRecord(makeRecord({ pid: 0 }), "x")).toBeUndefined()
		expect(parsePeerRecord(makeRecord(), "different")).toBeUndefined()
	})

	it("resolvePeer matches by name prefix and id prefix, flags ambiguity", () => {
		const a = makeRecord({ sessionId: "aaa-1", name: "alpha" })
		const b = makeRecord({ sessionId: "aab-2", name: "alphabet" })
		expect(resolvePeer("alpha", [a, b])).toEqual({ record: a })
		expect(resolvePeer("aaa", [a, b])).toEqual({ record: a })
		expect((resolvePeer("a", [a, b]) as { error: string }).error).toMatch(/ambiguous/i)
		expect((resolvePeer("zzz", [a, b]) as { error: string }).error).toMatch(/no live session/i)
		expect((resolvePeer("", [a]) as { error: string }).error).toMatch(/empty/i)
	})

	it("persists and reads session names; names.json is not a peer record", () => {
		expect(readPeerName(dir, "s1")).toBeUndefined()
		writePeerName(dir, "s1", "api-worker")
		expect(readPeerName(dir, "s1")).toBe("api-worker")
		writePeerName(dir, "s1", "renamed")
		expect(readPeerName(dir, "s1")).toBe("renamed")
		expect(readPeerName(dir, "s2")).toBeUndefined()
		// names.json must not surface as a (malformed) peer record.
		registerPeer(dir, makeRecord())
		const live = listLivePeers(dir)
		expect(live).toHaveLength(1)
		expect(live[0].record.name).toBe("alpha")
	})

	it("peerLabel prefers the session name and shortens the id", () => {
		expect(peerLabel(makeRecord())).toBe("alpha (019f1111) · /tmp/work")
		expect(peerLabel(makeRecord({ name: undefined }))).toBe("session-019f1111 · /tmp/work")
	})

	it("agentDirFromSessionFile extracts the host agent dir", () => {
		expect(agentDirFromSessionFile("/home/u/.pi/agent/sessions/--Users-u-proj--/s.jsonl")).toBe("/home/u/.pi/agent")
		expect(agentDirFromSessionFile("/Users/u/.config/kimchi/harness/sessions/--Users-u--/s.jsonl")).toBe(
			"/Users/u/.config/kimchi/harness",
		)
		expect(agentDirFromSessionFile(undefined)).toBeUndefined()
		expect(agentDirFromSessionFile("/tmp/random.jsonl")).toBeUndefined()
	})

	it("peerStateDir honors the env override and defaults under the agent dir", () => {
		process.env.AGENT_COLAB_STATE_DIR = "/tmp/custom-peers"
		expect(peerStateDir()).toBe("/tmp/custom-peers")
		delete process.env.AGENT_COLAB_STATE_DIR
		const fallback = peerStateDir()
		// Default lives under pi's agent dir (redirected by the host harness) …
		expect(fallback.endsWith("peers")).toBe(true)
		// … and is absolute.
		expect(fallback.startsWith("/")).toBe(true)
		expect(readdirSync(dir)).toHaveLength(0) // sanity: test dir untouched
	})

	it("isSafeStatePath-style guard: records outside dir are ignored", () => {
		// readPeer on an id whose record file doesn't exist returns undefined.
		expect(listLivePeers(join(dir, "nonexistent-subdir"))).toEqual([])
	})
})

afterAll(() => {
	if (dir && existsSync(dir)) {
		for (const f of readdirSync(dir)) {
			removePeer(dir, f.replace(/\.json$/, ""))
		}
	}
})
