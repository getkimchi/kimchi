#!/usr/bin/env bash
set -euo pipefail

: "${KIMCHI_API_KEY:?KIMCHI_API_KEY is required}"
: "${GCS_BUCKET:?GCS_BUCKET is required}"

# DinD sidecar exposes Docker on TCP 2375; tell the Docker CLI where to talk.
# Wait for DinD sidecar to be ready (up to 30s). Benchmark container and DinD
# start concurrently in K8s; dockerd takes a few seconds to come up.
for i in $(seq 1 30); do
    if curl -fsS "tcp://localhost:2375/_ping" >/dev/null 2>&1; then
        break
    fi
    echo "==> Waiting for Docker daemon ($i/30)..."
    sleep 1
done

if ! curl -fsS "tcp://localhost:2375/_ping" >/dev/null 2>&1; then
    echo "ERROR: Docker daemon did not become ready on tcp://localhost:2375"
    exit 1
fi

export DOCKER_HOST="tcp://localhost:2375"

cd /workspace

RUN_ID="${RUN_ID:-$(date +%Y%m%d_%H%M%S)}"
PARALLEL="${HARBOR_PARALLEL:-8}"

echo "==> Running terminal-bench-2 (parallel=${PARALLEL}, model=${MODEL:-default})"

# Pass -n for parallelism; remaining positional args forwarded for overrides.
./scripts/run-release.sh -n "${PARALLEL}" "$@"

JOBS_DIR="/workspace/jobs"
if [[ ! -d "$JOBS_DIR" ]]; then
    echo "ERROR: Jobs directory $JOBS_DIR does not exist"
    exit 1
fi

LATEST_JOB=$(ls -td "$JOBS_DIR"/*/ 2>/dev/null | head -1 | sed 's/\/$//')
if [[ -z "$LATEST_JOB" ]]; then
    echo "ERROR: No job directories found in $JOBS_DIR"
    exit 1
fi

echo "==> Uploading results to gs://${GCS_BUCKET}/terminal-bench-2/${RUN_ID}/"
gsutil -m cp -r "${LATEST_JOB}" "gs://${GCS_BUCKET}/terminal-bench-2/${RUN_ID}/"

echo "==> Done: gs://${GCS_BUCKET}/terminal-bench-2/${RUN_ID}/"