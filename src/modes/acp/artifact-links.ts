import { statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { type Artifact, artifactsFromToolCall } from "../../extensions/artifacts/detect.js"
import type { RecordedArtifact } from "../../extensions/artifacts/recorder.js"
import { kimchiDevMetaOf } from "./capabilities.js"
import type { ModelAttribution } from "./model-attribution.js"

// Max sniffed (bash/powershell) artifacts a single turn may carry. Bash
// results are capped per call (MAX_BASH_ARTIFACTS), but a turn can run many
// calls. Past the cap the oldest sniffed entry is evicted. Only sniffed
// artifacts count: write/edit and tool-declared (details.artifacts) paths
// are intentional and always land — otherwise a late plan could be
// ejected by earlier sniffed noise.
const MAX_TURN_ARTIFACTS = 32

// Two artifacts with the same basename (docs/report.md, out/report.md)
// would render identical labels. Disambiguate with the shortest unique
// trailing path-suffix. The distinguishing depth is a property of the whole
// collision group: one uniform k per group, searched once (per-artifact
// bounds could leave a short-path member with a bare basename next to deep
// labels). Uniqueness is guaranteed at k = maxLen because artifact paths
// are deduped. The empty leading segment of an absolute POSIX path is
// dropped from the label ("/a/b.md" renders "a/b.md").
// `takenNames` protects cross-batch uniqueness: names already emitted
// earlier in the same turn (mid-turn vs turn-end batches) can't be reused,
// so a later same-basename artifact deepens its label until it's free.
function disambiguateNames(artifacts: Artifact[], takenNames?: Set<string>): Artifact[] {
	const byName = new Map<string, Artifact[]>()
	for (const a of artifacts) byName.set(a.name, [...(byName.get(a.name) ?? []), a])
	const out: Artifact[] = []
	for (const group of byName.values()) {
		if (group.length === 1) {
			const only = group[0]
			out.push(takenNames?.has(only.name) ? { ...only, name: deepenUntilFree(only.name, only.path, takenNames) } : only)
			continue
		}
		const parts = group.map((g) => g.path.split(/[/\\]/).filter(Boolean))
		const maxLen = Math.max(...parts.map((p) => p.length))
		let k = 2
		while (k < maxLen && new Set(parts.map((p) => p.slice(-k).join("/"))).size < group.length) k++
		for (const [i, artifact] of group.entries()) {
			let name = parts[i].slice(-k).join("/")
			if (takenNames?.has(name)) name = deepenUntilFree(name, artifact.path, takenNames)
			out.push({ ...artifact, name })
		}
	}
	return out
}

// A group-local name already used earlier this turn: extend with one more
// path segment until unique (bounded by the path's own length).
function deepenUntilFree(name: string, path: string, taken: Set<string>): string {
	const parts = path.split(/[/\\]/).filter(Boolean)
	let candidate = name
	let k = name.split("/").length + 1
	while (k <= parts.length && taken.has(candidate)) candidate = parts.slice(-k++).join("/")
	return candidate
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
	/** Snapshot from noteTextBlock; used when the meta map has no entry. */
	fallbackAttribution?: ModelAttribution
}): SessionUpdate[] {
	// Prefer the map: it also carries mid-stream corrections (responseModel).
	const attribution = opts.seenModelMeta?.get(opts.messageId) ?? opts.fallbackAttribution
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
	private readonly sniffedKeys: string[] = []
	// Per-turn state for mid-turn emitNow: paths already chipped (skip at
	// flush, suppress re-declarations) and names already shown (later
	// batches must not reuse a colliding label).
	private readonly emittedPaths = new Set<string>()
	private readonly emittedNames = new Set<string>()
	private lastBlockId: string | undefined
	private lastBlockMeta: ModelAttribution | undefined

	get size(): number {
		return this.artifacts.size
	}

	/**
	 * Register a text block id as the attachment candidate; `meta` is the
	 * block's metadata relayed verbatim to flush — a fallback for blocks
	 * missing from the emitted meta map at flush time (e.g. a terminal
	 * tool-call-only message followed the text block). The buffer never
	 * reads it; interpretation lives in the chunk builder.
	 */
	noteTextBlock(messageId: string, meta?: ModelAttribution): void {
		this.lastBlockId = messageId
		this.lastBlockMeta = meta
	}

	/**
	 * Fold one completed tool call's detected artifacts into the buffer.
	 * Live-only: detection always stat-verifies candidates. Replay fills
	 * the buffer from recorded rows (adoptRecorded), never from tool data.
	 */
	collectFromToolCall(opts: {
		toolName: string
		args: unknown
		result: unknown
		cwd: string
		/** Foreground mtime window start; sniffed bash candidates require a fresh mtime. */
		windowStart?: number
	}): void {
		for (const artifact of artifactsFromToolCall(opts.toolName, opts.args, opts.result, opts.cwd, {
			windowStart: opts.windowStart,
		})) {
			this.addEntry(artifact.origin, artifact)
		}
	}

	/**
	 * Buffered artifacts carrying the tool's declared flag — the paths the
	 * tool itself surfaced (details.artifacts). The emitNow trigger needs
	 * exactly these keys, and they agree with buffer keys by construction
	 * (both come from the same parse; no re-parse against the result).
	 */
	getDeclaredPaths(): string[] {
		return [...this.artifacts.values()].filter((a) => a.origin === "declared").map((a) => a.path)
	}

	/**
	 * Replay: fold a recorded artifact row (written live by the recorder
	 * extension) into the buffer. One row per producing assistant message,
	 * so a turn may carry several — merge by resolved path, never clear:
	 * the clear existed to discard replay-side re-derivation, which replay
	 * no longer does at all.
	 */
	adoptRecorded(artifacts: RecordedArtifact[]): void {
		for (const artifact of artifacts) {
			const origin: Artifact["origin"] = artifact.sniffed ? "sniffed" : "write"
			this.addEntry(origin, {
				uri: pathToFileURL(artifact.path).href,
				path: artifact.path,
				name: artifact.name,
				origin,
				...(artifact.mimeType !== null && artifact.mimeType !== undefined ? { mimeType: artifact.mimeType } : {}),
			})
		}
	}

	/**
	 * Mid-turn emission for tool-declared artifacts (details.artifacts):
	 * marks the named paths emitted and flushes them NOW against the
	 * current text block — e.g. a submitted plan chips before its review
	 * questionnaire opens. [] when no text block has streamed yet (entries
	 * stay buffered — covered by the turn-end flush once a block streams)
	 * or the paths aren't buffered. Emitted entries are marked, not
	 * removed: the turn-end flush skips them (no double-chip), a later
	 * re-declaration stays silent (per-turn dedupe), and their names stay
	 * in the taken set so later batches keep labels unambiguous.
	 */
	emitNow(paths: string[], seenModelMeta?: Map<string, ModelAttribution>): SessionUpdate[] {
		const messageId = this.lastBlockId
		if (messageId === undefined) return []
		const emitted: Artifact[] = []
		for (const path of paths) {
			const artifact = this.artifacts.get(path)
			if (artifact === undefined || this.emittedPaths.has(path)) continue
			this.emittedPaths.add(path)
			emitted.push(artifact)
		}
		if (emitted.length === 0) return []
		const named = disambiguateNames(emitted, this.emittedNames)
		for (const artifact of named) this.emittedNames.add(artifact.name)
		return buildArtifactLinkChunks({
			messageId,
			artifacts: named,
			seenModelMeta,
			fallbackAttribution: this.lastBlockMeta,
		})
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
		let artifacts = [...this.artifacts.values()].filter((a) => !this.emittedPaths.has(a.path))
		const messageId = this.lastBlockId
		const fallback = this.lastBlockMeta
		const takenNames = new Set(this.emittedNames)
		this.artifacts.clear()
		this.sniffedKeys.length = 0
		this.emittedPaths.clear()
		this.emittedNames.clear()
		this.lastBlockId = undefined
		this.lastBlockMeta = undefined
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
		return buildArtifactLinkChunks({
			messageId,
			artifacts: disambiguateNames(artifacts, takenNames),
			seenModelMeta,
			fallbackAttribution: fallback,
		})
	}

	// Per-turn cap: sniffed entries evict oldest-past-the-cap; intentional
	// ones (writes/edits/declared — recorded rows mark them sniffed:false)
	// always land and promote a previously sniffed same path out of
	// eviction eligibility. Shared by live collection and row adoption so
	// cross-row turns still bound like one live turn would.
	private addEntry(origin: Artifact["origin"], artifact: Artifact): void {
		// Already chipped mid-turn: no re-chip, no buffer churn.
		if (this.emittedPaths.has(artifact.path)) return
		if (origin === "sniffed") {
			if (this.artifacts.has(artifact.path)) return
			this.sniffedKeys.push(artifact.path)
			this.artifacts.set(artifact.path, artifact)
			if (this.sniffedKeys.length > MAX_TURN_ARTIFACTS) {
				const evicted = this.sniffedKeys.shift()
				if (evicted !== undefined) this.artifacts.delete(evicted)
			}
			return
		}
		this.removeFromSniffed(artifact.path)
		this.artifacts.set(artifact.path, artifact)
	}

	private removeFromSniffed(path: string): void {
		const index = this.sniffedKeys.indexOf(path)
		if (index >= 0) this.sniffedKeys.splice(index, 1)
	}
}
