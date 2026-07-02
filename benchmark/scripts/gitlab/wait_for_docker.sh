#!/usr/bin/env bash
# Wait for the Docker daemon (DinD sidecar) to be ready before proceeding.
# Used in terminal-bench-2-chunk before_script.
set -euo pipefail

log_info() { echo "[INFO] $*"; }
log_error() { echo "[ERROR] $*" >&2; }

log_info "Waiting for Docker daemon..."
max_attempts=30
attempt=0

while ! docker info >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [[ $attempt -ge $max_attempts ]]; then
        log_error "Docker daemon not ready after ${max_attempts} seconds"
        exit 1
    fi
    log_info "Docker not ready yet, waiting... (attempt $attempt/$max_attempts)"
    sleep 1
done

log_info "Docker daemon is ready"
