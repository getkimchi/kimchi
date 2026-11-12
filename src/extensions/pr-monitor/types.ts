export interface PRCheck {
	id: string
	name: string
	state: "pending" | "passed" | "failed" | "skipped"
	url: string | null
	summary: string
}
export interface PRFeedback {
	id: string
	author: string
	body: string
	path: string | null
	line: number | null
	url: string
	trusted: boolean
}
export interface PRSnapshot {
	provider: "github" | "gitlab"
	repository: string
	number: number
	title: string
	url: string
	branch: string
	headSha: string
	state: "open" | "closed" | "merged"
	checks: PRCheck[]
	feedback: PRFeedback[]
}
export interface PRMonitorState {
	revision: number
	enabled: boolean
	autoFix: boolean
	phase: "idle" | "watching" | "fixing" | "attention" | "error"
	pullRequest: PRSnapshot | null
	checkedAt: string | null
	message: string | null
}
export function prKey(pr: PRSnapshot): string {
	return pr.url
}
