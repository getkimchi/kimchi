export function listFailLogs(dir: string): string[]
export function newFailLogs(before: string[], after: string[]): string[]
export function parseTuiFlakyCount(output: string): number
export function writeTuiAllureResult(options: {
	resultsDir: string
	stem: string
	exitCode: number
	start: number
	stop: number
	failLogPaths?: string[]
	flakyCount?: number
	failureMessage?: string
}): void
export function githubRunUrl(): string | undefined
