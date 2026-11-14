export type PRRepairMode = "ci" | "reviews" | "all"

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

/** One watched PR and what the user granted for it; saved with the session. */
export interface WatchTarget {
	url: string
	cwd: string
	/** False once stopped. Stopped targets stay listed so the saved general choice never restarts them. */
	enabled: boolean
	autoFix: boolean
	mode: PRRepairMode
	instructions: string
	attempts: number
	handled: string[]
}

export interface TargetState extends WatchTarget {
	phase: "watching" | "fixing" | "attention" | "error"
	pullRequest: PRSnapshot | null
	checkedAt: string | null
	message: string | null
}

export interface PRWatchState {
	targets: TargetState[]
	/** Requests that failed for some targets while the others started. */
	message: string | null
}
