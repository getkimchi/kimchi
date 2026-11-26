export function mergeTimings(
	previous: Record<string, number>,
	measurements: Record<string, number>[],
	existingStems: string[],
): Record<string, number>

export function describeChanges(
	before: Record<string, number>,
	after: Record<string, number>,
): { updated: number; added: number; removed: number }

export type Target = { kind: "latest" } | { kind: "run"; runId: string } | { kind: "folder"; folder: string }

export function parseTarget(arg: string | undefined): Target

export function runIdsWithReports(
	artifacts: { expired: boolean; created_at: string; workflow_run: { id: number } }[],
): string[]
