import type { WorkerClient } from "./client.js"

export interface PutSecretOptions {
	name: string
	/** Raw (un-encoded) secret value; base64-encoded before sending. */
	value: string
	injectIntoEnv?: boolean
}

/**
 * Write or overwrite a secret on the sandbox. The worker expects the value
 * base64-encoded; callers pass the raw string and we encode it here.
 */
export async function putSecret(client: WorkerClient, opts: PutSecretOptions, signal?: AbortSignal): Promise<void> {
	await client.putVoid(
		"/secrets",
		{
			name: opts.name,
			value: Buffer.from(opts.value, "utf-8").toString("base64"),
			...(opts.injectIntoEnv !== undefined ? { injectIntoEnv: opts.injectIntoEnv } : {}),
		},
		signal,
	)
}

export async function deleteSecret(client: WorkerClient, name: string, signal?: AbortSignal): Promise<void> {
	await client.del(`/secrets/${encodeURIComponent(name)}`, signal)
}
