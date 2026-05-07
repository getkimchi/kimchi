# Autonomous mode

`kimchi auto` runs the agent unattended on a prompt or task spec. By default it runs in-process; with `--runtime` it sandboxes the run inside a Docker / OrbStack / Podman container.

It's a thin wrapper around `--yolo --print --mode json --no-session` plus optional iteration cap, wall-clock timeout, and a result manifest written to disk.

---

## Quick start — in-process

```bash
# Bare prompt
kimchi auto "Refactor the auth module"

# With caps
kimchi auto --iterations 10 --timeout-seconds 600 "Refactor the auth module"

# Prompt from a file (pi's @file syntax)
kimchi auto @prompt.md

# Structured spec
kimchi auto --task task.json
```

A `result.json` is written to `<KIMCHI_RESULT_DIR or cwd>/.kimchi/` summarising the run.

## Quick start — containerized

```bash
# 1. Build the image (multi-arch optional — see scripts/build-image.sh --multi)
./scripts/build-image.sh

# 2. Write a task spec
cat > task.json <<'EOF'
{
  "prompt": "Add a CHANGELOG.md summarising recent commits.",
  "timeout_seconds": 600
}
EOF

# 3. Run sandboxed against a workspace
kimchi auto \
    --task task.json \
    --runtime orbstack \
    --workspace ./repo \
    --image kimchi:latest

# 4. Inspect the result
cat ./repo/.kimchi/result.json
cat ./repo/.kimchi/run.log
```

When `--runtime` is set:
- `--workspace <dir>` (default: current directory) is bind-mounted into `/workspace` inside the container.
- `--image <ref>` (default: `kimchi:latest`) is the container image to run.
- `--task <path>` is required (a structured spec — bare prompts aren't sandboxed in v1).

Exit codes: **0** on clean completion, **124** on timeout, non-zero otherwise.

---

## Task spec format (JSON)

| Field              | Type                                                | Default | Description                                                                                                          |
| ------------------ | --------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `prompt`           | string (required, non-empty)                        | —       | The user prompt the agent receives.                                                                                  |
| `model`            | string                                              | —       | Model pattern; defaults to whatever kimchi is configured for.                                                        |
| `timeout_seconds`  | integer (1 – 21600)                                 | 3600    | Wall-clock budget. **6h hard cap is enforced regardless of value.**                                                  |
| `iterations`       | integer (1 – 1000)                                  | —       | Optional cap on number of agent turns. When unset, the agent runs until pi's print mode resolves naturally.          |
| `env`              | `Record<string, string>`                            | `{}`    | Extra env vars forwarded into the container.                                                                         |
| `mounts`           | `Array<{host, container, readonly?}>`               | `[]`    | Additional bind mounts beyond the default `<workspace>:/workspace`.                                                  |
| `success_criteria` | string                                              | —       | Free-form, passed through to the prompt as guidance. v1: not validated.                                              |

Spec file is JSON only in v1. YAML may be added later.

## CLI flag reference

| Flag | Effect |
|---|---|
| `--task <path>` | Load TaskSpec JSON. Required when `--runtime` is set. |
| `--iterations N` / `--max-iterations N` | Cap turn count. Overrides `spec.iterations`. |
| `--timeout-seconds N` | Wall-clock cap. Overrides `spec.timeout_seconds`. |
| `--runtime <name>` | Sandbox the run in a container. Values: `docker`, `orbstack`, `podman`. |
| `--workspace <dir>` | Container only. Bind-mounted as `/workspace`. Default: current dir. |
| `--image <ref>` | Container only. Image to run. Default: `kimchi:latest`. |
| `--help` / `-h` | Show usage. |
| `@file.md` | (pi-native) Use file content as prompt. |
| anything else | Passed through to pi-coding-agent. |

CLI flags override spec values when both are present.

---

## Result manifest

After the container exits, the launcher reads `<workspace>/.kimchi/result.json`:

```json
{
  "exit_reason": "done" | "timeout" | "error",
  "started_at": "2026-05-06T12:34:56.000Z",
  "ended_at":   "2026-05-06T12:39:01.000Z",
  "last_message": "All tests pass.",
  "log_path": "/workspace/.kimchi/run.log",
  "diff_path": "/workspace/.kimchi/diff.patch",
  "error": { "message": "...", "stack": "..." }
}
```

`last_message` is the latest assistant turn's text. `diff_path` is best-effort — populated only when the workspace is a git repo.

---

## Runtime backends

| `--runtime` value                        | Backend            | Notes                                                                       |
| ---------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `docker`                                 | `docker run`       | Standard local Docker.                                                      |
| `orbstack`                               | `docker run`       | OrbStack ships a `docker` CLI shim — same code path, different VM.          |
| `podman`                                 | `podman run`       | OCI-compatible drop-in.                                                     |

---

## Security caveats

> **Warning:** autonomous mode runs with `--yolo`, which bypasses every permission prompt and rule. The agent has unrestricted ability to run commands, read/write files, and access the network from inside the container.

- **Never bind-mount your home directory or working tree directly.** Mount a fresh `git clone` instead. The container runs as non-root (`uid 1000`), but the bind-mount remains writable.
- The container has full network access by default. Add `--network none` (Docker) when you don't need it.
- Treat the workspace as untrusted output — review the `diff_path` before merging anything generated by an autonomous run.
- Secrets pass through `env`. Avoid putting long-lived credentials in the spec; use short-lived tokens or workload identity in production.
- The launcher forwards `KIMCHI_API_KEY` from your shell into the container; ensure your shell does not have a wider-scoped key than necessary.

### Workspace ownership

The container runs as `uid 1000`. If your bind-mounted workspace is owned by a different UID, the agent will fail to write `.kimchi/result.json` and the run will appear to hang or exit silently. Either:
- chown the workspace before launch (`chown -R 1000:1000 ./workspace`), or
- pass `--user $(id -u):$(id -g)` via a future runtime flag (not implemented in v1).

---

## Exit codes

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| 0    | Agent's prompt completed cleanly (pi print mode resolved). |
| 1    | Spec load failure, runtime selection failure, or other generic error before the container started. |
| 124  | Wall-clock timeout (matches the GNU `timeout(1)` convention). |
| 130  | SIGINT (e.g. Ctrl-C in the launcher).                 |
| 143  | SIGTERM (e.g. `docker stop`).                         |
| other| Container-internal failure; check `result.json.error` and `run.log`. |

---

## How it works (architecture)

```text
┌───────── host (your laptop / cluster controller) ─────────┐
│                                                            │
│  kimchi auto --runtime <name>                              │
│    │                                                       │
│    ├─ load TaskSpec (Zod-validated)                        │
│    ├─ ensure <workspace>/.kimchi/                          │
│    ├─ copy task.json → <workspace>/.kimchi/task.json       │
│    ├─ select runtime: docker | orbstack | podman           │
│    ├─ runtime.run({image, mounts, env, command})  ──┐      │
│    │                                                ▼      │
└────────────────────────────────────────────────────────────┘
                                                     │
┌────────────── container (PID 1: kimchi auto) ──────┴───────┐
│                                                            │
│   parseAutoArgs → loadTaskSpec → buildAutoArgs              │
│       │                                                     │
│       ▼                                                     │
│   pi-coding-agent main() in --print --mode json mode        │
│       │  + autonomous extension factories                   │
│       │                                                     │
│       ├─ resultWriterExtension     — captures lifecycle     │
│       │       └─ session_shutdown → write result.json       │
│       ├─ timeoutGuardExtension     — wall-clock kill switch │
│       │       └─ onTimeout → result.markTimeout() + exit124 │
│       └─ maxIterationsExtension    — cap on turn_end count  │
│               └─ on N-th turn → ctx.shutdown()              │
│                                                             │
│   pi's print mode resolves naturally when session.prompt    │
│   completes; the manifest is flushed on session_shutdown.   │
└─────────────────────────────────────────────────────────────┘
```

The two halves communicate **only via the workspace mount and exit codes** — no sockets, no IPC. That keeps each half independently testable and lets the same `kimchi auto` run on bare metal or in any OCI-compatible container with no code changes.

---

## Running the end-to-end smoke test

A real-Docker, real-LLM smoke lives at `tests/smoke/autonomous-e2e.test.ts`. It builds the kimchi image, runs `kimchi auto --runtime docker` against a tiny task that writes a file, and verifies the result manifest plus the file the agent was asked to create. It is gated behind `KIMCHI_E2E=1` because it costs LLM tokens and needs Docker running.

Prerequisites:

- Node 22 + bun (for cross-compiling the linux binary)
- Docker or OrbStack running
- `KIMCHI_API_KEY` exported in your shell
- `pnpm build:binary-linux-x64` already run (so `dist/bin/kimchi-linux-amd64` or `dist/bin/kimchi` exists)

Run it:

```bash
pnpm build:binary-linux-x64
KIMCHI_API_KEY=$YOUR_KEY pnpm test:e2e
```
