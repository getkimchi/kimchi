/**
 * Read-accuracy metrics used by accuracy.test.ts (and later by the write
 * verification harness): CER, word F1, reading-order Kendall τ, and table
 * cell accuracy. Thresholds live in the test file next to the fixture
 * corpus so the plan's numbers stay visible where they're enforced.
 */

/** Character Error Rate (Levenshtein / reference length). Whitespace-normalized. */
export function cer(reference: string, actual: string): number {
	const ref = normalize(reference)
	const act = normalize(actual)
	if (ref.length === 0) return act.length === 0 ? 0 : 1
	const dist = levenshtein(ref, act)
	return dist / ref.length
}

function normalize(s: string): string {
	return s.replace(/\s+/g, " ").trim()
}

export function levenshtein(a: string, b: string): number {
	const m = a.length
	const n = b.length
	if (m === 0) return n
	if (n === 0) return m
	let prev = new Array<number>(n + 1)
	let curr = new Array<number>(n + 1)
	for (let j = 0; j <= n; j++) prev[j] = j
	for (let i = 1; i <= m; i++) {
		curr[0] = i
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
		}
		;[prev, curr] = [curr, prev]
	}
	return prev[n]
}

export function words(s: string): string[] {
	return normalize(s).toLowerCase().split(" ").filter(Boolean)
}

/** Bag-of-words F1 over token multisets. */
export function wordF1(reference: string, actual: string): number {
	const ref = words(reference)
	const act = words(actual)
	if (ref.length === 0 && act.length === 0) return 1
	if (ref.length === 0 || act.length === 0) return 0
	const counts = new Map<string, number>()
	for (const w of ref) counts.set(w, (counts.get(w) ?? 0) + 1)
	let common = 0
	for (const w of act) {
		const c = counts.get(w) ?? 0
		if (c > 0) {
			counts.set(w, c - 1)
			common++
		}
	}
	const precision = common / act.length
	const recall = common / ref.length
	return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
}

/**
 * Kendall τ between two orderings of the same items (reading order).
 * items: ground-truth ordered list; actual: order in which those items first
 * appear in the extracted output.
 */
export function kendallTau(referenceOrder: string[], actualOrder: string[]): number {
	if (referenceOrder.length < 2) return 1
	const pos = new Map(actualOrder.map((item, i) => [item, i]))
	const order = referenceOrder.map((item) => pos.get(item) ?? Number.POSITIVE_INFINITY)
	let concordant = 0
	let discordant = 0
	for (let i = 0; i < order.length; i++) {
		for (let j = i + 1; j < order.length; j++) {
			if (order[i] < order[j]) concordant++
			else discordant++
		}
	}
	return (concordant - discordant) / (concordant + discordant)
}

/** Fraction of truth table cells found (textually, normalized) in the output. */
export function tableCellAccuracy(truthCells: string[], actualText: string): number {
	if (truthCells.length === 0) return 1
	const haystack = normalize(actualText)
	let hits = 0
	for (const cell of truthCells) {
		if (haystack.includes(normalize(cell))) hits++
	}
	return hits / truthCells.length
}
