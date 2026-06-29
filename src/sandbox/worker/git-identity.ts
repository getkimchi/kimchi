import type { WorkerClient } from "./client.js"
import { type CreateGitIdentityRequest, type GitIdentity, type UpdateGitIdentityRequest, WorkerError } from "./types.js"

/**
 * Set the global git user name/email on the sandbox via
 * `PUT /gitidentity` (worker runs `git config --global user.name/user.email`).
 * No-op if both are empty.
 */
export async function setGitGlobalConfig(
	client: WorkerClient,
	cfg: { name?: string; email?: string },
	signal?: AbortSignal,
): Promise<void> {
	if (!cfg.name && !cfg.email) return
	const user: { name?: string; email?: string } = {}
	if (cfg.name) user.name = cfg.name
	if (cfg.email) user.email = cfg.email
	await client.putVoid("/gitidentity", { user }, signal)
}

export async function listGitIdentities(client: WorkerClient, signal?: AbortSignal): Promise<GitIdentity[]> {
	return client.get<GitIdentity[]>("/gitidentity", signal)
}

export async function getGitIdentity(client: WorkerClient, host: string, signal?: AbortSignal): Promise<GitIdentity> {
	return client.get<GitIdentity>(`/gitidentity/${encodeURIComponent(host)}`, signal)
}

export async function createGitIdentity(
	client: WorkerClient,
	host: string,
	req: CreateGitIdentityRequest,
	signal?: AbortSignal,
): Promise<GitIdentity> {
	return client.post<GitIdentity>(`/gitidentity/${encodeURIComponent(host)}`, req, signal)
}

export async function updateGitIdentity(
	client: WorkerClient,
	host: string,
	req: UpdateGitIdentityRequest,
	signal?: AbortSignal,
): Promise<GitIdentity> {
	return client.put<GitIdentity>(`/gitidentity/${encodeURIComponent(host)}`, req, signal)
}

export async function deleteGitIdentity(client: WorkerClient, host: string, signal?: AbortSignal): Promise<void> {
	await client.del(`/gitidentity/${encodeURIComponent(host)}`, signal)
}

/**
 * Create or update the git identity for a host. Tries POST first; on a 409
 * (identity already exists) falls back to PUT. Safe to call on every attach.
 */
export async function upsertGitIdentity(
	client: WorkerClient,
	host: string,
	req: CreateGitIdentityRequest,
	signal?: AbortSignal,
): Promise<GitIdentity> {
	try {
		return await createGitIdentity(client, host, req, signal)
	} catch (err) {
		if (err instanceof WorkerError && err.status === 409) {
			return updateGitIdentity(client, host, req, signal)
		}
		throw err
	}
}
