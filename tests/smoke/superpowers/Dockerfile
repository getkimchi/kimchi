FROM ubuntu:24.04

# curl for downloading if needed; ca-certificates for HTTPS; tar is pre-installed
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
 && rm -rf /var/lib/apt/lists/*

# Copy the Linux kimchi binary and its auxiliary share dir
COPY dist/bin/kimchi-linux-arm64  /usr/local/bin/kimchi
COPY dist/share/kimchi/       /usr/local/share/kimchi/

# Tell kimchi where its auxiliary files live
ENV PI_PACKAGE_DIR=/usr/local/share/kimchi

RUN chmod +x /usr/local/bin/kimchi

# Run as a non-root user — mimics a realistic install
RUN useradd -m tester
USER tester
WORKDIR /home/tester

COPY tests/smoke/superpowers/test.sh /home/tester/test.sh
