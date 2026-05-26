FROM golang:1.23-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates procps && \
    rm -rf /var/lib/apt/lists/*

ENV GOFLAGS=-mod=mod \
    GOTOOLCHAIN=local

WORKDIR /app
