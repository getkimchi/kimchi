export interface RunOpts {
	image: string
	command: string[] // exec command, e.g. ["auto", "--task", "/workspace/task.json"]
	mounts?: Array<{ host: string; container: string; readonly?: boolean }>
	env?: Record<string, string>
	workdir?: string
	name?: string // container name (CLI runtimes only)
	timeoutMs?: number // outer wall-clock cap on .run()
}

export interface RunResult {
	exitCode: number
	durationMs: number
}

export type SpawnFn = (
	binary: string,
	args: string[],
	opts: { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; signal?: AbortSignal },
) => Promise<{ exitCode: number }>

export interface ContainerRuntime {
	readonly name: string
	run(opts: RunOpts): Promise<RunResult>
}
