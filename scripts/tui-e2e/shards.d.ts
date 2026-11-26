export interface Shard {
	stems: string[]
	seconds: number
}

export function planShards(stems: string[], timings: Record<string, number>, total: number): Shard[]

export function shardDriftWarning(plannedSeconds: number, actualSeconds: number): string | null
