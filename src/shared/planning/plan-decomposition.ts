/**
 * # Plan Decomposition
 *
 * Converts a plain-text plan (potentially containing `## ` level-2 markdown
 * headings) into a structured `PlannedPhase`.
 *
 * ## Input shape
 *
 * `planText` is raw markdown emitted by the planner model.  It may be a
 * single paragraph or consist of multiple `## ` sections:
 *
 * ```markdown
 * ## Implement feature X
 * Do the thing.
 *
 * ## Write tests
 * Verify the thing works.
 * ```
 *
 * ## Output shape
 *
 * `decomposePlanToPhase` returns a `PlannedPhase` — a lightweight pre-cursor
 * to the full `Phase` runtime type defined in `src/ferment/types.ts`.  The
 * `PlannedPhase` / `PlannedStep` shapes carry only the fields the
 * START_AS_FERMENT branch needs; the caller (permissions / lifecycle code)
 * is responsible for materialising a real `Phase` from the result.
 *
 * ## Consumer contract
 *
 * The primary consumer is the `START_AS_FERMENT` branch at
 * `permissions/index.ts:498`.  Downstream lifecycle code (e.g. the ferment
 * step FSM) consumes the `PlannedPhase` produced here and creates a real
 * `Phase` instance from it.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lightweight step produced by the planner decomposer.
 * Corresponds to a `## ` section (or the entire plan when no sections exist).
 */
export interface PlannedStep {
	id: string
	index: number
	description: string
}

/**
 * Lightweight phase produced by the planner decomposer.
 * Corresponds to an entire plan text, subdivided into `PlannedStep`s.
 */
export interface PlannedPhase {
	id: string
	index: number
	name: string
	goal: string
	steps: PlannedStep[]
}

/**
 * A chunk extracted from the `## Chunks` section of a shared plan.
 * Carries the chunk's heading title and body so the caller can format a
 * concrete step description.
 */
export interface ParsedPlanChunk {
	/** The heading title (e.g. "Chunk 1: Add cache primitive"). */
	title: string
	/** Raw body content of the chunk (everything between the heading and the
	 *  next heading). May include sub-bullets like Files Changed, Accept When,
	 *  etc. */
	body: string
}

/**
 * Structured fields extracted from a plan that follows the shared planning
 * process structure (Goal / Constraints / Chunks / Verification Strategy /
 * Decision Log / Risks).
 *
 * The Start-as-ferment branch uses this to seed a real ferment
 * (`successCriteria`, `constraints`, `phases[0].steps`) rather than
 * splitting every `##` heading into a step — which would turn
 * `## Verification Strategy`, `## Decision Log`, `## Risks` into spurious
 * implementation steps.
 *
 * Missing sections are returned as empty strings/arrays so callers can decide
 * whether to fall back to draft-only or refuse the promotion entirely.
 */
export interface ParsedPlan {
	/** Body of the `## Goal` section, joined into a single string. */
	goal: string
	/** Bullet list items from the `## Constraints` section. */
	constraints: string[]
	/** Aggregated `Accept When` items from every chunk — these become ferment
	 *  `successCriteria`. */
	successCriteria: string[]
	/** Each `###` chunk inside `## Chunks`, in document order. */
	chunks: ParsedPlanChunk[]
}

// ---------------------------------------------------------------------------
// Shared plan parser
// ---------------------------------------------------------------------------

/**
 * Section headings the shared planning process produces. Only `Goal`,
 * `Constraints`, and `Chunks` produce structured fields — the rest (Verification
 * Strategy, Decision Log, Risks) are metadata and must NOT be turned into
 * implementation steps.
 */
const SECTION_HEADINGS = ["Goal", "Constraints", "Chunks", "Verification Strategy", "Decision Log", "Risks"] as const

type SectionHeading = (typeof SECTION_HEADINGS)[number]

/**
 * Splits a plan text into a map of `## Heading` → body. Headings that aren't
 * in `SECTION_HEADINGS` are dropped (so unknown sections never leak into
 * structured fields).
 *
 * Matching is case-sensitive on the canonical headings the shared process
 * emits. Trailing colons (`## Goal:`) are tolerated.
 */
function splitTopLevelSections(planText: string): Map<SectionHeading, string> {
	const sections = new Map<SectionHeading, string>()
	// Split on lines starting with "## " (top-level headings only — don't
	// consume `### ` sub-headings used inside Chunks).
	const parts = planText.split(/(?=^##\s+(?!#))/mu)

	for (const part of parts) {
		const match = part.match(/^##\s+([^\n:]+):?\s*\n([\s\S]*)$/)
		if (!match) continue
		const heading = match[1].trim()
		const body = match[2].trim()
		const canonical = SECTION_HEADINGS.find((s) => s === heading)
		if (canonical) sections.set(canonical, body)
	}

	return sections
}

/** Extract bullet-list items from a section body. Recognises `- `, `* `, and
 *  numbered lists (`1. `, `2. `). Empty input returns an empty array. */
function extractBullets(body: string): string[] {
	const lines = body.split("\n")
	const bullets: string[] = []
	for (const line of lines) {
		const match = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/)
		if (match) bullets.push(match[1].trim())
	}
	return bullets
}

/**
 * Split the `## Chunks` body into individual `### ` chunks. Each chunk
 * carries its heading title and raw body (so the caller can extract
 * Accept When, Files Changed, etc. separately).
 */
function splitChunks(chunksBody: string): ParsedPlanChunk[] {
	if (chunksBody.trim() === "") return []
	const chunks: ParsedPlanChunk[] = []
	// Each chunk starts at a `### ` heading.
	const parts = chunksBody.split(/(?=^###\s+)/mu)
	for (const part of parts) {
		const match = part.match(/^###\s+([^\n]+)\n?([\s\S]*)$/)
		if (!match) continue
		const title = match[1].trim()
		const body = match[2].trim()
		if (title) chunks.push({ title, body })
	}
	return chunks
}

/**
 * Pull `Accept When` items out of a single chunk body. The shared process
 * documents `**Accept When**: 2-3 concrete, verifiable criteria` followed by
 * bullets, but the model may also emit them as a single line or as nested
 * bullets. We grab any inline value and any bullets that follow the
 * `Accept When` label until the next `**...` label.
 */
function extractAcceptWhen(chunkBody: string): string[] {
	const criteria: string[] = []
	const lines = chunkBody.split("\n")
	let capturing = false
	for (const rawLine of lines) {
		const line = rawLine.trim()
		const startMatch = line.match(/^-?\s*\*\*Accept When\*\*\s*:?\s*(.*)$/i)
		if (startMatch) {
			capturing = true
			const inline = startMatch[1].trim()
			if (inline) {
				// Inline form: "Accept When: criterion A; criterion B" — split on ; or , when present
				const inlineItems = inline.split(/\s*;\s*/).filter(Boolean)
				criteria.push(...inlineItems.map((s) => s.trim()))
			}
			continue
		}
		if (!capturing) continue
		// Stop capturing on the next `**Label**:` (e.g. **Files Changed**, **Test Coverage**)
		if (/^-?\s*\*\*[^*]+\*\*\s*:?/.test(line)) {
			capturing = false
			continue
		}
		// Bullet under Accept When
		const bulletMatch = line.match(/^[-*]\s+(.+)$/)
		if (bulletMatch) {
			criteria.push(bulletMatch[1].trim())
		} else if (line === "") {
			// Blank line inside the Accept When block is allowed but does not stop capture.
		} else {
			// Non-bullet, non-label line ends capture.
			capturing = false
		}
	}
	return criteria
}

/**
 * Parse a plan that follows the shared planning process structure into
 * structured fields. Missing sections produce empty strings/arrays so the
 * caller can decide whether to fall back to draft-only behaviour or refuse
 * the promotion entirely.
 *
 * The Start-as-ferment branch (`permissions/index.ts`) uses this to seed a
 * real ferment with the right `goal`, `constraints`, `successCriteria`, and
 * `phases[0].steps` instead of treating every `## ` heading as a step.
 */
export function parseSharedPlan(planText: string): ParsedPlan {
	const trimmed = planText.trim()
	if (trimmed === "") {
		return { goal: "", constraints: [], successCriteria: [], chunks: [] }
	}

	const sections = splitTopLevelSections(trimmed)
	const goal = (sections.get("Goal") ?? "").trim()
	const constraints = extractBullets(sections.get("Constraints") ?? "")
	const chunks = splitChunks(sections.get("Chunks") ?? "")
	const successCriteria: string[] = []
	for (const chunk of chunks) {
		successCriteria.push(...extractAcceptWhen(chunk.body))
	}

	return { goal, constraints, successCriteria, chunks }
}

// ---------------------------------------------------------------------------
// Decomposer
// ---------------------------------------------------------------------------

/**
 * Splits a plan text into a `PlannedPhase`.
 *
 * - If `planText` contains `## ` headings, each heading section becomes a
 *   `PlannedStep`; the heading title is discarded and only the body is kept.
 * - If no headings are found, the entire `planText` is returned as a single
 *   step.
 * - Empty input (`planText.trim() === ""`) returns a phase with one step whose
 *   description is `""`.
 *
 * IDs are deterministic: `phase.id = "phase-1"`, `step.id = "step-N"` with
 * 1-based indices.
 */
export function decomposePlanToPhase(planText: string): PlannedPhase {
	const trimmed = planText.trim()

	// Empty plan: return a phase with a single empty step.
	if (trimmed === "") {
		return {
			id: "phase-1",
			index: 1,
			name: "",
			goal: "",
			steps: [{ id: "step-1", index: 1, description: "" }],
		}
	}

	// Split on lines starting with "## " (escaped for regex, anchored).
	// Uses a positive lookahead so the heading line itself is not consumed —
	// it is trimmed off explicitly below.
	const parts = trimmed.split(/(?=^##\s+)/mu)

	const steps: PlannedStep[] = []

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]
		const firstLine = part.split("\n")[0]

		// Strip the leading "## " marker.
		const description = part.startsWith("## ") ? part.slice(3).trim() : part.trim()

		// Sections whose first line is a bare "## " with no text are empty after
		// the marker is removed; skip them.
		if (description === "" && firstLine.startsWith("## ")) {
			continue
		}

		// Non-heading leading parts that are also empty should be skipped
		// (the loop above handles this by checking firstLine only when it is
		// a heading; a non-heading part will fall through to the else below).
		if (description === "" && i === 0) {
			continue
		}

		steps.push({
			id: `step-${steps.length + 1}`,
			index: steps.length + 1,
			description,
		})
	}

	// No ## headings found — return single-step phase with entire plan text.
	if (steps.length === 0) {
		const firstNonEmptyLine = trimmed.split("\n").find((l) => l.trim() !== "") ?? ""

		return {
			id: "phase-1",
			index: 1,
			name: firstNonEmptyLine,
			goal: trimmed,
			steps: [{ id: "step-1", index: 1, description: trimmed }],
		}
	}

	// Use the first line of the plan text as the phase title (strip markdown
	// heading markers if present); fall back to empty string.
	const firstLine = trimmed
		.split("\n")[0]
		.replace(/^#+\s*/, "")
		.trim()

	return {
		id: "phase-1",
		index: 1,
		name: firstLine,
		goal: firstLine,
		steps,
	}
}
