import type { WorkerClient } from "./client.js"
import type { SandboxStatus } from "./types.js"

export async function getStatus(client: WorkerClient, signal?: AbortSignal): Promise<SandboxStatus> {
	return client.get<SandboxStatus>("/status", signal)
}
