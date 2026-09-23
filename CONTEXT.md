# Kimchi

The kimchi coding harness: a local TUI that can dispatch and supervise agent runs on remote execution environments.

## Language

**Sandbox**:
The remote execution environment (a workspace pod) that kimchi reaches over a WebSocket tunnel via a local ssh proxy. Phased out of direct reachability: all contact goes through the tunnel.
_Avoid_: remote worker, remote machine, pod (in prose)

**Remote run**:
An agent run dispatched to a sandbox ("continue in remote session"), supervised locally: dispatch, live steering, completion review, and git hand-back.
_Avoid_: cloud agent, remote session (the session record is `RemoteSessionMeta`; the run is the lifecycle)

**Sandbox-ssh**:
The single owner of how local processes ssh into a sandbox: the ssh option policy (proxy command, host-key acceptance, keepalive), its string- and argv-forms, the proxy auth environment, and the per-call temp-dir/known_hosts lifecycle.
_Avoid_: sandbox-git ssh options, rsync ssh options, GIT_SSH_COMMAND construction (per-caller leaks of the one policy)
