#!/usr/bin/env bash
# Downloads pinned, checksum-verified ripgrep and fd binaries into one folder.
# The setup action caches that folder, keyed on this file, so changing a
# version or checksum here refreshes the cache.
# Usage: install-search-tools.sh <target-dir>
set -euo pipefail

RG_VERSION="15.2.0"
FD_VERSION="10.5.2"

target="${1:?usage: install-search-tools.sh <target-dir>}"

case "$(uname -s)-$(uname -m)" in
Linux-x86_64)
	arch="x86_64"
	rg_sha256="33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c"
	fd_sha256="7e2d07fa2b8807642aaec67b7e2972a9fbe4db26fcb340a7372392db42b26694"
	;;
Linux-aarch64)
	arch="aarch64"
	rg_sha256="800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915"
	fd_sha256="63ea52cb31586e6d98efa2f06d73d542f16c7d0c4af0f07b579aaf9714cf907a"
	;;
*)
	echo "install-search-tools: unsupported platform $(uname -s)-$(uname -m)" >&2
	exit 1
	;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# fetch <url> <sha256> <binary name inside the archive>
fetch() {
	local url="$1" sha256="$2" binary="$3" archive name
	name="$(basename "$url" .tar.gz)"
	archive="$work/$name.tar.gz"
	curl --fail --silent --show-error --location --retry 3 --output "$archive" "$url"
	echo "$sha256  $archive" | sha256sum -c - >/dev/null
	tar -xzf "$archive" -C "$work"
	install -m 0755 "$work/$name/$binary" "$target/$binary"
}

mkdir -p "$target"
fetch "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${arch}-unknown-linux-musl.tar.gz" "$rg_sha256" rg
fetch "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-${arch}-unknown-linux-musl.tar.gz" "$fd_sha256" fd
