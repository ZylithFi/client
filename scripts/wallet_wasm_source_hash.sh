#!/usr/bin/env bash
# the hash of every input the wallet wasm is built from. the wasm build stamps it beside the
# artifact, and `--check` fails when the checked-in artifact was built from other sources: the
# app deploy has no rust toolchain and ships the checked-in artifact as it is.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="${ZYLITH_WALLET_WASM_OUT_DIR:-${ROOT_DIR}/public/wallet}/source-hash.txt"

source_hash() {
  cd "${ROOT_DIR}"
  git ls-files -co --exclude-standard -- \
    core/src core/Cargo.toml wallet_wasm/src wallet_wasm/Cargo.toml Cargo.toml Cargo.lock rust-toolchain.toml \
    | LC_ALL=C sort \
    | while read -r file; do
        [[ -f "${file}" ]] && printf '%s  %s\n' "$(shasum -a 256 < "${file}" | cut -d' ' -f1)" "${file}"
      done \
    | shasum -a 256 \
    | cut -d' ' -f1
}

case "${1:-}" in
  --write) source_hash > "${STAMP}" ;;
  --check)
    expected="$(source_hash)"
    actual="$(cat "${STAMP}" 2>/dev/null || true)"
    if [[ "${expected}" != "${actual}" ]]; then
      echo "the checked-in wallet wasm is stale: rebuild it with client/build-wallet-wasm.sh" >&2
      exit 1
    fi
    ;;
  *) source_hash ;;
esac
