import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { kimchiDevMetaOf } from "./capabilities.js"
import type { ModelAttribution } from "./model-attribution.js"
import { type Artifact, artifactsFromToolCall } from "./tool-calls/artifacts.js"

/**
 * Build the wire shape for generated-artifact chips: one `resource_link`
 * agent_message_chunk per artifact, attached to `messageId` and carrying
 * `_meta["kimchi.dev"].type = "artifact"` so clients can tell generated
 * files apart from links the model merely references in text.
 *
 * The block's emitted model attribution is merged into each chunk's
 * `_meta`: the client's rule is last-wins on the whole `_meta` blob per
 * messageId (docs/acp-model-attribution.md), so an artifacts-only payload
 * would WIPE the attribution that block id carried.
 *
 * This is the ONLY construction site for artifact chunks — live turns and
 * replay both build through here so the shape cannot drift.
 */
export function buildArtifactLinkChunks(opts: {
	messageId: string
	artifacts: Artifact[]
	seenModelMeta?: Map<string, ModelAttribution>
}): SessionUpdate[] {
	const attribution = opts.seenModelMeta?.get(opts.messageId)
	return opts.artifacts.map((artifact) => ({
		sessionUpdate: "agent_message_chunk",
		content: {
			type: "resource_link",
			uri: artifact.uri,
			name: artifact.name,
			...(artifact.mimeType !== undefined ? { mimeType: artifact.mimeType } : {}),
		},
		messageId: opts.messageId,
		_meta: kimchiDevMetaOf({ ...(attribution ?? {}), type: "artifact" }),
	}))
}

/**
 * Per-turn artifact accumulator — the ONE implementation of the attachment
 * rule shared by the live turn (finalizeTurn) and replay (turn boundary /
 * branch end):
 *
 * 1. Artifacts detected from completed tool calls accumulate across the
 *    whole turn, deduped by resolved path.
 * 2. Chips attach to the turn's LAST text (agent_message) block id — every
 *    text block id must be registered via noteTextBlock. Thinking blocks
 *    are never registered callers' side, so an attachment slot never lands
 *    on a kind that would render a spurious empty message on kind-keyed
 *    clients.
 * 3. flush() builds the chunks and clears the state. With no artifacts or
 *    no registered text block (tool-call-only / thinking-only turn) it
 *    returns nothing: a fresh `km.N` would have no persisted counterpart,
 *    so such turns drop their chips by design (live/replay parity).
 *
 * Emission is turn-scoped (Claude-style trailing artifacts): one
 * deterministic flush point, no mid-turn deferral state.
 */
export class TurnArtifactBuffer {
	private readonly artifacts = new Map<string, Artifact>()
	private lastBlockId: string | undefined

	get size(): number {
		return this.artifacts.size
	}

	/** Register a text block id as the current attachment candidate. */
	noteTextBlock(messageId: string): void {
		this.lastBlockId = messageId
	}

	/**
	 * Fold artifacts detected from one completed tool call into the buffer.
	 * Delegates to the pure detection module (allowlist + resolution); pass
	 * `verifyExists: false` for replay, where files may no longer exist.
	 */
	collectFromToolCall(opts: {
		toolName: string
		args: unknown
		result: unknown
		cwd: string
		verifyExists?: boolean
	}): void {
		for (const artifact of artifactsFromToolCall(opts.toolName, opts.args, opts.result, opts.cwd, {
			verifyExists: opts.verifyExists ?? true,
		})) {
			this.artifacts.set(artifact.path, artifact)
		}
	}

	/**
	 * Build the flush chunks and clear all state. Returns [] when there is
	 * nothing to attach or no attachment point. `seenModelMeta` may be
	 * absent (partial test harnesses without a loaded SessionRecord).
	 */
	flush(seenModelMeta?: Map<string, ModelAttribution>): SessionUpdate[] {
		const artifacts = [...this.artifacts.values()]
		const messageId = this.lastBlockId
		this.artifacts.clear()
		this.lastBlockId = undefined
		if (artifacts.length === 0 || messageId === undefined) return []
		return buildArtifactLinkChunks({ messageId, artifacts, seenModelMeta })
	}
}
