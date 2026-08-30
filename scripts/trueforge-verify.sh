#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="22.13.0"
PNPM_VERSION="11.19.0"
PNPM_SHA224="e2c0ae209c6e56fb502d0a596818c9b298e1bf39f2be3002c5709351"
PNPM_DESCRIPTOR="pnpm@${PNPM_VERSION}+sha224.${PNPM_SHA224}"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_ARCHIVE_SHA256="3ff0d57063c33313d73d0bdcebc4c778ad6be948234584694a042c6fe57164f6"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "ExitRamp sandbox verification requires Linux x86-64." >&2
  exit 2
fi

REPOSITORY_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPOSITORY_ROOT"
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "ExitRamp refuses to verify a dirty sandbox checkout." >&2
  exit 2
fi

CACHE_ROOT="${XDG_CACHE_HOME:-${HOME}/.cache}/exitramp"
COREPACK_HOME="${CACHE_ROOT}/corepack"
export COREPACK_HOME
mkdir -p "$CACHE_ROOT" "$COREPACK_HOME"

DOWNLOAD_DIR="$(mktemp -d "${CACHE_ROOT}/node-download.XXXXXX")"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT
curl --fail --silent --show-error --location \
  "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
  --output "${DOWNLOAD_DIR}/${NODE_ARCHIVE}"
printf '%s  %s\n' "$NODE_ARCHIVE_SHA256" "${DOWNLOAD_DIR}/${NODE_ARCHIVE}" | sha256sum --check --status
tar -xJf "${DOWNLOAD_DIR}/${NODE_ARCHIVE}" -C "$DOWNLOAD_DIR"
NODE_ROOT="${DOWNLOAD_DIR}/node-v${NODE_VERSION}-linux-x64"

export PATH="${NODE_ROOT}/bin:${PATH}"
if [[ "$(node --version)" != "v${NODE_VERSION}" ]]; then
  echo "Pinned Node.js bootstrap failed." >&2
  exit 2
fi

corepack enable --install-directory "${NODE_ROOT}/bin" pnpm >/dev/null
corepack install --global "$PNPM_DESCRIPTOR" >/dev/null
if [[ "$(pnpm --version)" != "$PNPM_VERSION" ]]; then
  echo "Pinned pnpm bootstrap failed." >&2
  exit 2
fi

LOG_DIR=".exitramp/verification-logs"
mkdir -p "$LOG_DIR"
if ! pnpm install --frozen-lockfile >"${LOG_DIR}/install.stdout" 2>"${LOG_DIR}/install.stderr"; then
  echo "Dependency installation failed; logs remain in ${LOG_DIR}." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Dependency installation changed tracked repository files; verification stopped." >&2
  exit 2
fi

pnpm exec tsx src/trueforge/verification-runner.ts
