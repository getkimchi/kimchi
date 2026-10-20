import { statSync } from "node:fs"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { kimchiDevMetaOf } from "./capabilities.js"
import type { ModelAttribution } from "./model-attribution.js"
import { type Artifact, artifactsFromToolCall } from "./tool-calls/artifacts.js"

// Max artifacts a single turn may carry. Bash results are capped per call
// (MAX_BASH_ARTIFACTS in tool-calls/artifacts.ts), but a turn can run many
// calls; without a turn-level cap one flush could emit an unbounded burst
// of resource_link updates.
const MAX_TURN_ARTIFACTS = 32

// Two artifacts with the same basename (docs/report.md, out/report.md)
// would render identical labels. Disambiguate with the shortest unique
// trailing path-suffix.
function disambiguateNames(artifacts: Artifact[]): Artifact[] {
	const byName = new Map<string, Artifact[]>()
	for (const a of artifacts) byName.set(a.name, [...(byName.get(a.name) ?? []), a])
	const out: Artifact[] = []
	for (const group of byName.values()) {
		if (group.length === 1) {
			out.push(group[0])
			continue
		}
		for (const artifact of group) {
			let label = artifact.name
			const segments = artifact.path.split(/[/\\]/)
			for (let k = 2; k <= segments.length; k++) {
				const labels = new Set(group.map((g) => g.path.split(/[/\\]/).slice(-k).join("/")))
				if (labels.size === group.length) {
					label = segments.slice(-k).join("/")
					break
				}
			}
			out.push({ ...artifact, name: label })
		}
	}
	return out
}

/**
 * Build artifact chunks: one `resource_link` agent_message_chunk per
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
 *    artifacts are dropped by design.
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
		/** Foreground mtime window start; sniffed bash candidates require a fresh mtime. */
		windowStart?: number
	}): void {
		for (const artifact of artifactsFromToolCall(opts.toolName, opts.args, opts.result, opts.cwd, {
			verifyExists: opts.verifyExists ?? true,
			windowStart: opts.windowStart,
		})) {
			if (!this.artifacts.has(artifact.path) && this.artifacts.size >= MAX_TURN_ARTIFACTS) continue
			this.artifacts.set(artifact.path, artifact)
		}
	}

	/**
	 * Build the flush chunks and clear state; [] when nothing to attach or
	 * no attachment point. `seenModelMeta` may be absent in partial test
	 * harnesses.
	 *
	 * Live flushes re-verify every artifact still exists and is a file: a
	 * tool call may have produced it temporarily and deleted it before the
	 * turn ended. Replay flushes pass verifyExists:false — replayed artifacts
	 * keep pointing at files that may legitimately be gone.
	 */
	flush(seenModelMeta?: Map<string, ModelAttribution>, opts?: { verifyExists?: boolean }): SessionUpdate[] {
		let artifacts = [...this.artifacts.values()]
		const messageId = this.lastBlockId
		this.artifacts.clear()
		this.lastBlockId = undefined
		if (artifacts.length === 0 || messageId === undefined) return []
		if (opts?.verifyExists !== false) {
			artifacts = artifacts.filter((a) => {
				try {
					return statSync(a.path).isFile()
				} catch {
					return false
				}
			})
			if (artifacts.length === 0) return []
		}
		return buildArtifactLinkChunks({ messageId, artifacts: disambiguateNames(artifacts), seenModelMeta })
	}
}
