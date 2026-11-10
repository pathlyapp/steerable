#!/bin/sh
# Install steerable-cli.
#
#   curl -fsSL https://steerableframework.com/install.sh | sh
#
# The npm package carries the platform runtime, so the only prerequisite is
# Node. This script installs Node when it is missing or too old, then installs
# the CLI and verifies it.
#
# Options (environment):
#   STEERABLE_VERSION=0.9.0     install an exact version instead of latest
#   STEERABLE_PREFIX=~/.local   install prefix for the Node toolchain
#   STEERABLE_NO_NODE=1         never install Node; fail instead
set -eu

REQUIRED_MAJOR=22
REQUIRED_MINOR=19
PACKAGE="@steerable/agent-cli"
VERSION="${STEERABLE_VERSION:-latest}"
PREFIX="${STEERABLE_PREFIX:-$HOME/.local}"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Prints the installed node version, or nothing.
node_version() {
  command -v node >/dev/null 2>&1 || return 0
  node -p 'process.versions.node' 2>/dev/null || true
}

# True when major.minor is at least $REQUIRED_MAJOR.$REQUIRED_MINOR.
version_ok() {
  version=$1
  [ -n "$version" ] || return 1
  major=$(printf '%s' "$version" | cut -d. -f1)
  minor=$(printf '%s' "$version" | cut -d. -f2)
  [ "$major" -gt "$REQUIRED_MAJOR" ] && return 0
  [ "$major" -eq "$REQUIRED_MAJOR" ] && [ "$minor" -ge "$REQUIRED_MINOR" ] && return 0
  return 1
}

install_node() {
  [ "${STEERABLE_NO_NODE:-0}" = "1" ] && fail "Node.js ${REQUIRED_MAJOR}.${REQUIRED_MINOR} or newer is required and was not found on PATH."
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        say "Installing Node.js with Homebrew…"
        brew install node
        return 0
      fi
      say "Homebrew not found; installing Node.js from nodejs.org into ${PREFIX}…"
      install_node_tarball
      ;;
    Linux)
      install_node_tarball
      ;;
    *)
      fail "unsupported operating system: $(uname -s). Install Node.js ${REQUIRED_MAJOR}.${REQUIRED_MINOR}+ and rerun."
      ;;
  esac
}

install_node_tarball() {
  case "$(uname -s)" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    *) fail "unsupported operating system: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
  # Follow the LTS line; the CLI needs 22.19, which every newer LTS satisfies.
  base="https://nodejs.org/dist/latest-v${REQUIRED_MAJOR}.x"
  file="node-vVERSION-${platform}-${arch}.tar.gz"
  say "Resolving the current Node.js ${REQUIRED_MAJOR}.x release…"
  index=$(curl -fsSL "${base}/" 2>/dev/null || true)
  [ -n "$index" ] || fail "could not reach ${base}; install Node.js manually and rerun."
  resolved=$(printf '%s' "$index" | sed -n "s/.*href=\"node-\(v[0-9.]*\)-${platform}-${arch}\.tar\.gz\".*/\1/p" | head -n 1)
  [ -n "$resolved" ] || fail "could not find a Node.js ${REQUIRED_MAJOR}.x build for ${platform}-${arch}."
  archive=$(printf '%s' "$file" | sed "s/VERSION/${resolved}/")
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  say "Downloading ${archive}…"
  curl -fsSL "${base}/${archive}" -o "${tmp}/${archive}" || fail "download failed"
  say "Verifying checksum…"
  curl -fsSL "${base}/SHASUMS256.txt" -o "${tmp}/SHASUMS256.txt" || fail "checksum list download failed"
  expected=$(grep " ${archive}\$" "${tmp}/SHASUMS256.txt" | cut -d' ' -f1)
  [ -n "$expected" ] || fail "no checksum published for ${archive}"
  if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "${tmp}/${archive}" | cut -d' ' -f1)
  else
    actual=$(sha256sum "${tmp}/${archive}" | cut -d' ' -f1)
  fi
  [ "$expected" = "$actual" ] || fail "checksum mismatch for ${archive}"
  mkdir -p "${PREFIX}"
  tar -xzf "${tmp}/${archive}" -C "${tmp}"
  rm -rf "${PREFIX}/node"
  mv "${tmp}/node-${resolved}-${platform}-${arch}" "${PREFIX}/node"
  PATH="${PREFIX}/node/bin:${PATH}"
  export PATH
  say "Installed Node.js ${resolved} into ${PREFIX}/node"
}

install_cli() {
  if [ "$(id -u)" = "0" ] && [ -z "${STEERABLE_PREFIX:-}" ]; then
    say "Installing ${PACKAGE}@${VERSION} globally…"
    npm install -g "${PACKAGE}@${VERSION}"
  else
    # A user-level prefix needs no sudo and leaves the system Node untouched.
    prefix="${PREFIX}/npm"
    mkdir -p "$prefix"
    say "Installing ${PACKAGE}@${VERSION} into ${prefix}…"
    npm install --prefix "$prefix" "${PACKAGE}@${VERSION}"
    path_hint="${prefix}/node_modules/.bin"
    case ":${PATH}:" in
      *":${path_hint}:"*) ;;
      *)
        say ""
        say "Add this to your shell profile so the command is found:"
        say "  export PATH=\"${path_hint}:\$PATH\""
        ;;
    esac
  fi
}

main() {
  current=$(node_version)
  if version_ok "$current"; then
    say "Node.js ${current} found."
  else
    if [ -n "$current" ]; then
      say "Node.js ${current} is older than ${REQUIRED_MAJOR}.${REQUIRED_MINOR}."
    else
      say "Node.js not found."
    fi
    install_node
    current=$(node_version)
    version_ok "$current" || fail "Node.js installation did not produce a usable version on PATH."
    say "Node.js ${current} is ready."
  fi
  command -v npm >/dev/null 2>&1 || fail "npm not found next to Node.js ${current}."
  install_cli
  # Confirm the command actually runs before telling the user it is ready.
  installed=$(command -v steerable-cli 2>/dev/null || true)
  if [ -z "$installed" ]; then
    for candidate in "${PREFIX}/npm/node_modules/.bin/steerable-cli" "${PATH%%:*}/steerable-cli"; do
      [ -x "$candidate" ] && installed="$candidate" && break
    done
  fi
  [ -n "$installed" ] || fail "steerable-cli was not installed on PATH; see the PATH line above."
  version=$("$installed" --version 2>/dev/null || echo unknown)
  say "steerable-cli ${version} installed."
  say ""
  say "Installed. Next:"
  say "  steerable-cli login"
  say "  steerable-cli run \"summarize this repo\""
  say ""
  say "If the command is not found, open a new shell or add the PATH line above."
}

main
