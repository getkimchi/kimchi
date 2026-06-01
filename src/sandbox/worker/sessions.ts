import type { WorkerClient } from "./client.js"
import type { CreateSessionRequest, Session } from "./types.js"

export async function listSessions(client: WorkerClient, signal?: AbortSignal): Promise<Session[]> {
	const map = await client.get<Record<string, Omit<Session, "name">>>("/session", signal)
	return Object.entries(map).map(([name, s]) => ({ ...s, name }))
}

export async function getSession(client: WorkerClient, name: string, signal?: AbortSignal): Promise<Session> {
	const s = await client.get<Omit<Session, "name">>(`/session/${encodeURIComponent(name)}`, signal)
	return { ...s, name }
}

export async function createSession(
	client: WorkerClient,
	name: string,
	req: CreateSessionRequest,
	opts: { sessionFile?: string; signal?: AbortSignal } = {},
): Promise<Session> {
	const s = await client.postMultipart<Omit<Session, "name">>(
		`/session/${encodeURIComponent(name)}`,
		{ request: req, sessionFile: opts.sessionFile },
		opts.signal,
	)
	return { ...s, name }
}

export async function deleteSession(client: WorkerClient, name: string, signal?: AbortSignal): Promise<void> {
	await client.del(`/session/${encodeURIComponent(name)}`, signal)
}
