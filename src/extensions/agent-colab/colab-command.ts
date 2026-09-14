/**
 * /colab — the user-facing picker.
 *
 * Lists live local sessions (from the peer registry), lets the user pick one,
 * links it as this session's worker, and offers to inject a note so the agent
 * knows it can start delegating via ask_peer / message_peer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { listLivePeers, type PeerRecord, peerLabel } from "./registry.js"
import { PEER_MESSAGE_TYPE } from "./renderer.js"

export interface ColabCommandDeps {
	registryDir: string
	self: () => { sessionId: string; name?: string }
	link: (record: PeerRecord) => void
}

export function registerColabCommand(pi: ExtensionAPI, deps: ColabCommandDeps): void {
	pi.registerCommand("colab", {
		description: "Pick another running session to collaborate with (link it as a worker)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return

			const entries = listLivePeers(deps.registryDir).filter((e) => e.record.sessionId !== deps.self().sessionId)
			if (entries.length === 0) {
				ctx.ui.notify(
					"No other live kimchi sessions found. Start one in another terminal and run /colab again.",
					"info",
				)
				return
			}

			const labels = entries.map((e) => peerLabel(e.record))
			const pick = await ctx.ui.select("Collaborate with which session?", labels)
			if (pick === undefined) return
			const index = labels.indexOf(pick)
			if (index < 0) return
			const record = entries[index].record

			deps.link(record)
			ctx.ui.notify(`Linked ${peerLabel(record)} as a worker.`, "info")

			const tellAgent = await ctx.ui.confirm(
				"Tell your agent?",
				`Inject a note so your agent treats "${record.name ?? record.sessionId.slice(0, 8)}" as a worker it can delegate to via ask_peer / message_peer.`,
			)
			if (!tellAgent) return

			await pi.sendMessage(
				{
					customType: PEER_MESSAGE_TYPE,
					content: [
						{
							type: "text",
							text: `User linked peer session "${record.name ?? record.sessionId.slice(0, 8)}" (${record.cwd}) as a collaborator via /colab. Treat it as a worker: hand it bounded, self-contained tasks via ask_peer (blocking) or message_peer (fire-and-forget). It is an independent session with its own user — never assume you can read its transcript; ask for conclusions and read pointed-to files yourself.`,
						},
					],
					display: true,
					details: { fromName: "user", text: "/colab link note" },
				},
				ctx.isIdle() ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" },
			)
		},
	})
}
