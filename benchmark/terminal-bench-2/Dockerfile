# Stage 1: Sync dependencies with uv
FROM ghcr.io/astral-sh/uv:python3.14-bookworm AS deps

WORKDIR /app

# Copy lockfile + pyproject.toml for reproducible deps
COPY pyproject.toml uv.lock ./

# Sync third-party dependencies only (not the local package — source is mounted at runtime)
RUN uv sync --frozen --no-install-project

# Stage 2: Runtime image
FROM python:3.14-slim-bookworm

# Install docker-ce-cli (for harbor --env docker) and google-cloud-cli (for gsutil)
RUN apt-get update && apt-get install -y --no-install-recommends \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli google-cloud-cli \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Copy benchmark source
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY pyproject.toml ./

# Copy .venv from deps stage
COPY --from=deps /app/.venv ./.venv

# Set environment
ENV PATH="/workspace/.venv/bin:${PATH}"
ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["./scripts/entrypoint.sh"]