import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { kimchiDevMetaOf } from "./capabilities.js"
import type { ModelAttribution } from "./model-attribution.js"
import { type Artifact, artifactsFromToolCall } from "./tool-calls/artifacts.js"

/**
 * Build artifact chip chunks: one `resource_link` agent_message_chunk per
 * artifact, attached to `messageId` and carrying
 * `_meta["kimchi.dev"].type = "artifact"` so clients can distinguish
 * generated files from links the model merely references.
 *
 * The block's emitted model attribution is merged into the `_meta` —
 * clients apply last-wins per messageId (docs/acp-model-attribution.md),
 * so omitting it would erase the attribution this block id carried.
 *
 * Only construction site for artifact chunks (used by live and replay).
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
 * Per-turn artifact accumulator, shared by the live turn (finalizeTurn)
 * and replay (turn boundary / branch end):
 *
 * 1. Artifacts from completed tool calls accumulate for the whole turn,
 *    deduped by resolved path.
 * 2. Chips attach to the turn's LAST text block id, registered via
 *    noteTextBlock. Thinking block ids are never registered (a chunk on
 *    one renders as an empty agent message on kind-keyed clients).
 * 3. flush() builds the chunks and clears state. It returns [] when no
 *    text block was registered (tool-call-only / thinking-only turn):
 *    a fresh `km.N` has no persisted counterpart for replay, so such
 *    chips are dropped by design.
 *
 * Emission is turn-scoped: one flush point per turn, no mid-turn state.
 */
export class TurnArtifactBuffer {
	private readonly artifacts = new Map<string, Artifact>()
	private lastBlockId: string | undefined

	get size(): number {
		return this.artifacts.size
	}

	/** Register a text block id as the attachment candidate. */
	noteTextBlock(messageId: string): void {
		this.lastBlockId = messageId
	}

	/**
	 * Fold one completed tool call's detected artifacts into the buffer.
	 * Pass `verifyExists: false` for replay (files may no longer exist).
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
	 * Build the flush chunks and clear state; [] when nothing to attach or
	 * no attachment point. `seenModelMeta` may be absent in partial test
	 * harnesses.
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
