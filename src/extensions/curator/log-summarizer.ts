import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { LogSummary } from "./types.js"

export type { LogSummary } from "./types.js"

const MAX_SUMMARIES = 20
const MAX_FAILURES = 50

export async function summarizeLogs(memoryDir: string): Promise<LogSummary> {
	const summariesDir = join(memoryDir, "summaries")
	const failureLogPath = join(memoryDir, "failure-log.jsonl")

	const [summaryFiles, failureContent] = await Promise.all([
		getRecentSummaryFiles(summariesDir),
		readFailureLog(failureLogPath),
	])

	return {
		summaries: summaryFiles,
		failurePatterns: aggregateFailurePatterns(failureContent),
	}
}

async function getRecentSummaryFiles(summariesDir: string): Promise<string[]> {
	try {
		const entries = await readdir(summariesDir, { withFileTypes: true })
		const files = entries
			.filter((e) => e.isFile() && e.name.endsWith(".md"))
			.map((e) => join(summariesDir, e.name))
			.sort()
			.reverse()
			.slice(0, MAX_SUMMARIES)

		const contents = await Promise.all(files.map((f) => readFile(f, "utf-8")))
		return contents
	} catch {
		return []
	}
}

async function readFailureLog(path: string): Promise<string[]> {
	try {
		const content = await readFile(path, "utf-8")
		const lines = content.split("\n").filter(Boolean).slice(-MAX_FAILURES)
		return lines
	} catch {
		return []
	}
}

interface FailureEntry {
	type: string
	timestamp: string
}

function aggregateFailurePatterns(entries: string[]): LogSummary["failurePatterns"] {
	const counts = new Map<string, { count: number; lastSeen: string }>()

	for (const line of entries) {
		try {
			const entry: FailureEntry = JSON.parse(line)
			const existing = counts.get(entry.type)
			if (existing) {
				existing.count++
				if (entry.timestamp > existing.lastSeen) {
					existing.lastSeen = entry.timestamp
				}
			} else {
				counts.set(entry.type, { count: 1, lastSeen: entry.timestamp })
			}
		} catch {
			// Skip malformed lines
		}
	}

	return Array.from(counts.entries()).map(([type, data]) => ({
		type,
		count: data.count,
		lastSeen: data.lastSeen,
	}))
}
