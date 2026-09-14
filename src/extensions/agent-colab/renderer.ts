/**
 * TUI renderer for inbound peer messages.
 *
 * Inbound messages are injected as custom-typed messages so the transcript
 * shows a labeled block (sender + body) instead of raw text — provenance is
 * always visible to the user, per the consent design.
 */

import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent"
import { Box, Spacer, Text } from "@earendil-works/pi-tui"

export const PEER_MESSAGE_TYPE = "agent-colab-peer-message"

export interface PeerMessageDetails {
	fromName?: string
	text?: string
}

const peerMessageRenderer: MessageRenderer<PeerMessageDetails> = (message, _options, theme) => {
	const details = message.details as PeerMessageDetails | undefined
	if (!details?.text) return undefined

	const box = new Box(1, 1, (text) => theme.fg("accent", text))
	box.addChild(
		new Text(
			theme.bold(
				theme.fg("customMessageLabel", `[peer message${details.fromName ? ` from ${details.fromName}` : ""}]`),
			),
			0,
			0,
		),
	)
	box.addChild(new Spacer(1))
	box.addChild(new Text(theme.fg("customMessageText", details.text), 0, 0))
	return box
}

export function registerPeerMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<PeerMessageDetails>(PEER_MESSAGE_TYPE, peerMessageRenderer)
}
