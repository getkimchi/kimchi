# syntax=docker/dockerfile:1.7

# Multi-arch container image for kimchi autonomous mode.
#
# Build with:
#   docker buildx build --platform linux/amd64,linux/arm64 -t kimchi:latest .
#
# Or use the convenience script: ./scripts/build-image.sh
#
# Expects the cross-compiled linux binary to have been built first via:
#   pnpm build:binary-linux-x64
#   pnpm build:binary-linux-arm64
# The build script picks the correct artifact based on TARGETARCH.

FROM --platform=$BUILDPLATFORM alpine:3.20 AS prep
ARG TARGETARCH
WORKDIR /prep
COPY dist/bin /prep/bin
COPY dist/share /prep/share
# Pick the right cross-built binary. Fail with a clear error if not found.
RUN set -eux; \
    if [ -f "/prep/bin/kimchi-linux-${TARGETARCH}" ]; then \
        cp "/prep/bin/kimchi-linux-${TARGETARCH}" /prep/kimchi; \
    else \
        echo "no kimchi-linux-${TARGETARCH} binary found; run pnpm build:binary-linux-${TARGETARCH}" >&2; exit 1; \
    fi; \
    chmod +x /prep/kimchi

FROM debian:bookworm-slim
ARG TARGETARCH
LABEL org.opencontainers.image.title="kimchi"
LABEL org.opencontainers.image.description="Autonomous coding agent runner"
LABEL org.opencontainers.image.source="https://github.com/cast-ai/kimchi"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        curl \
        tini; \
    rm -rf /var/lib/apt/lists/*; \
    useradd --create-home --shell /bin/bash --uid 1000 kimchi; \
    mkdir -p /workspace /workspace/.kimchi; \
    chown -R kimchi:kimchi /workspace

COPY --from=prep --chown=root:root /prep/kimchi /usr/local/bin/kimchi
COPY --from=prep --chown=root:root /prep/share /usr/local/share

USER kimchi
WORKDIR /workspace
ENV KIMCHI_RESULT_DIR=/workspace/.kimchi
ENV KIMCHI_LOG_PATH=/workspace/.kimchi/run.log
ENV HOME=/home/kimchi

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kimchi"]
CMD ["auto", "--task", "/workspace/.kimchi/task.json"]
