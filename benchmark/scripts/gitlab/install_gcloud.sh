#!/usr/bin/env bash
# Install and authenticate gcloud. Used in setup-image, chunk, and summary jobs.
# The chunk image ($BENCH_IMAGE) already has gcloud installed by
# docker/Dockerfile.bench, so the install block is skipped there and only the
# auth step runs.
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "==> Installing gcloud"
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg |
    gpg --dearmor --batch --yes -o /usr/share/keyrings/cloud.google.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update -qq
  apt-get install -y --no-install-recommends google-cloud-cli
fi

if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  gcloud auth login --cred-file="${GOOGLE_APPLICATION_CREDENTIALS}" --quiet
fi

gcloud --version
