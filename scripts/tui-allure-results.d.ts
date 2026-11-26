export function listFailLogs(dir: string): string[]
export function newFailLogs(before: string[], after: string[]): string[]
export function writeTuiAllureResult(options: {
	resultsDir: string
	stem: string
	exitCode: number
	start: number
	stop: number
	failLogPaths?: string[]
	failureMessage?: string
}): void
export function githubRunUrl(): string | undefined
