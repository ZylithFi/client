#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ZYLITH_WALLET_WASM_OUT_DIR:-${ROOT_DIR}/client/public/wallet}"
PROFILE="${ZYLITH_WALLET_WASM_PROFILE:-release}"
TARGET_DIR="${ROOT_DIR}/target/wasm32-unknown-unknown/${PROFILE}"
WASM_FILE="${TARGET_DIR}/zylith_wallet_wasm.wasm"

if [[ -d "${HOME}/.cargo/bin" ]]; then
  export PATH="${HOME}/.cargo/bin:${PATH}"
fi

if ! command -v rustup >/dev/null 2>&1; then
  echo "rustup is required to build the wallet WASM package" >&2
  exit 1
fi

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "wasm-bindgen CLI is required. Install the matching CLI with:" >&2
  echo "  cargo install wasm-bindgen-cli --version 0.2.123 --locked" >&2
  exit 1
fi

rustup target add wasm32-unknown-unknown >/dev/null

if [[ "${PROFILE}" == "release" ]]; then
  cargo build -p zylith-wallet-wasm --release --target wasm32-unknown-unknown
else
  cargo build -p zylith-wallet-wasm --target wasm32-unknown-unknown
fi

if [[ ! -f "${WASM_FILE}" ]]; then
  echo "wallet WASM artifact not found at ${WASM_FILE}" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
wasm-bindgen \
  --target web \
  --out-dir "${OUT_DIR}" \
  --out-name zylith_wallet_wasm \
  "${WASM_FILE}"

echo "wrote wallet WASM package to ${OUT_DIR}"
