import type { WorkerClient } from "../../../sandbox/worker/client.js"
import { setGitGlobalConfig, upsertGitIdentity } from "../../../sandbox/worker/git-identity.js"
import { putSecret } from "../../../sandbox/worker/secrets.js"

/**
 * Set the sandbox's global git identity (user.name / user.email) via the
 * worker `/gitidentity` API. No-op if both are undefined.
 */
export async function provisionGitIdentity(
	client: WorkerClient,
	cfg: { name?: string; email?: string },
	signal?: AbortSignal,
): Promise<void> {
	await setGitGlobalConfig(client, cfg, signal)
}

export interface ProvisionGitCredentialOptions {
	/** The git host to authenticate against (e.g. "github.com"). */
	gitHost: string
	/** The personal access token to use as the credential. */
	gitToken: string
	/** Username for the credential. Defaults to "oauth2". */
	gitUser?: string
}

/**
 * Derive a worker secret name for a git host's token. Secret names must match
 * `^[A-Za-z0-9_-]+$`, so dots and other characters in the host are sanitized
 * (the `/gitidentity/{host}` path param keeps the original host verbatim).
 */
export function gitTokenSecretName(host: string): string {
	return `git-token-${host.replace(/[^A-Za-z0-9_-]/g, "_")}`
}

/**
 * Configure git credentials on the sandbox via the worker APIs: store the token
 * as a secret, then bind the host to that secret through a git identity. The
 * worker's credential helper serves the token to git on demand — the token is
 * never sent over SSH. Safe to call on every attach (secret is overwritten and
 * the identity is upserted).
 */
export async function provisionGitCredential(
	client: WorkerClient,
	opts: ProvisionGitCredentialOptions,
	signal?: AbortSignal,
): Promise<void> {
	const user = opts.gitUser ?? "oauth2"
	const secretRef = gitTokenSecretName(opts.gitHost)

	// Write the secret first so the first git operation never races a missing
	// secret (the worker resolves secretRef lazily at git time).
	await putSecret(client, { name: secretRef, value: opts.gitToken }, signal)
	await upsertGitIdentity(client, opts.gitHost, { user, secretRef }, signal)
}
