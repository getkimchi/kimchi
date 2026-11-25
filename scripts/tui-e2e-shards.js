// Splits TUI e2e files into shards of about equal run time. Round-robin by
// name put most of the slow files into one shard, which then took twice as
// long as the others.

// Greedy longest-first packing: give each file, slowest first, to the shard
// with the least work so far. Files without a measured time count as the
// median. The result is the same on every runner for the same inputs.
export function planShards(stems, timings, total) {
	const known = stems.map((stem) => timings[stem]).filter((seconds) => typeof seconds === "number")
	const fallback = median(known) ?? 1
	const cost = (stem) => (typeof timings[stem] === "number" ? timings[stem] : fallback)

	const shards = Array.from({ length: total }, () => ({ stems: [], seconds: 0 }))
	const ordered = [...stems].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))
	for (const stem of ordered) {
		const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best))
		lightest.stems.push(stem)
		lightest.seconds += cost(stem)
	}
	for (const shard of shards) shard.stems.sort()
	return shards
}

function median(values) {
	if (values.length === 0) return undefined
	const sorted = [...values].sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
