export function mergeTimings(
	previous: Record<string, number>,
	measurements: Record<string, number>[],
	existingStems: string[],
): Record<string, number>
