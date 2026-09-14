import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { type AgentCard, startA2aServer } from "./a2a-server.js"
import { type PeerRecord, registerPeer } from "./registry.js"
import { type ColabToolDeps, createColabTools } from "./tools.js"

let dir: string

function cardFor(name: string): AgentCard {
	return {
		name,
		description: "fake peer",
		url: "",
		protocolVersion: "1.0",
		version: "0",
		capabilities: { streaming: false, pushNotifications: false },
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: [],
		securitySchemes: {},
		security: [],
	}
}

function peerRecord(name: string, port: number, token: string): PeerRecord {
	return {
		sessionId: `session-${name}`,
		pid: process.pid,
		port,
		token,
		name,
		cwd: `/tmp/${name}`,
		startedAt: new Date().toISOString(),
	}
}

function makeDeps(): { deps: ColabToolDeps; isLinked: (id: string) => boolean } {
	const linked = new Map<string, PeerRecord>()
	return {
		deps: {
			registryDir: dir,
			self: () => ({ sessionId: "self-1111-2222", name: "alpha-self" }),
			isLinked: (id) => linked.has(id),
			link: (r) => linked.set(r.sessionId, r),
			unlink: (id) => linked.delete(id),
		},
		isLinked: (id) => linked.has(id),
	}
}

async function exec(tool: ReturnType<typeof createColabTools>[number], params: Record<string, unknown>) {
	const res = (await tool.execute("call-1", params as never, undefined, undefined, { cwd: "/x" } as never)) as {
		content: ReadonlyArray<unknown>
	}
	// Tool results are text-only here; expose the first text part directly.
	return { ...res, text: (res.content[0] as { text: string }).text }
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-colab-tools-"))
})

describe("colab tools", () => {
	it("list → link → ask → message → unlink → ambiguity errors", async () => {
		const peerServer = await startA2aServer({
			card: cardFor("beta"),
			token: "tok-beta",
			deliver: async (text) => `PEER REPLY: ${text}`,
		})
		try {
			registerPeer(dir, peerRecord("beta", peerServer.port, "tok-beta"))
			const { deps, isLinked } = makeDeps()
			const [listPeers, linkPeer, unlinkPeer, askPeer, messagePeer] = createColabTools(deps)

			// list_peers: beta visible, self hidden, not linked
			const listed = await exec(listPeers, {})
			expect(listed.text).toContain("beta (session-")
			expect(listed.text).not.toContain("alpha-self")
			expect(listed.text).not.toContain("[linked]")

			// link → list shows [linked]
			const linked = await exec(linkPeer, { peer: "beta" })
			expect(linked.text).toContain("Linked")
			expect(isLinked("session-beta")).toBe(true)
			const relisted = await exec(listPeers, {})
			expect(relisted.text).toContain("[linked]")

			// ask_peer blocking round-trip
			const asked = await exec(askPeer, { peer: "beta", message: "check the flaky test" })
			expect(asked.text).toContain("PEER REPLY: check the flaky test")

			// message_peer fire-and-forget
			const sent = await exec(messagePeer, { peer: "beta", message: "fyi" })
			expect(sent.text).toContain("task task-")

			// unlink
			await exec(unlinkPeer, { peer: "beta" })
			expect(isLinked("session-beta")).toBe(false)

			// ambiguity + not-found
			const second = await startA2aServer({ card: cardFor("betamax"), token: "tok-betamax", deliver: async (t) => t })
			registerPeer(dir, peerRecord("betamax", second.port, "tok-betamax"))
			try {
				const ambiguous = await exec(askPeer, { peer: "bet", message: "x" })
				expect(ambiguous.text).toMatch(/ambiguous/i)
				const missing = await exec(askPeer, { peer: "zzz", message: "x" })
				expect(missing.text).toMatch(/no live session/i)
			} finally {
				await second.stop()
			}
		} finally {
			await peerServer.stop()
		}
	}, 20_000)

	it("ask_peer surfaces peer refusal as a failed task", async () => {
		const server = await startA2aServer({
			card: cardFor("grumpy"),
			token: "tok-grumpy",
			deliver: async () => {
				throw new Error("refused: not accepting")
			},
		})
		try {
			registerPeer(dir, peerRecord("grumpy", server.port, "tok-grumpy"))
			const { deps } = makeDeps()
			const [, , , askPeer] = createColabTools(deps)
			const res = await exec(askPeer, { peer: "grumpy", message: "hello" })
			expect(res.text).toContain("failed")
		} finally {
			await server.stop()
		}
	}, 15_000)
})
