#!/usr/bin/env bash
# Extract shared libraries Electron needs but the system lacks, without root, into <repo>/.local-libs/root.
# Used on WSL2 (Ubuntu 26.04) where only libasound.so.2 was missing. scripts/env.mjs adds the directory to
# LD_LIBRARY_PATH automatically.
#   usage: apps/ide/scripts/setup-linux-libs.sh [extra-package ...]
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
dest="$repo/.local-libs"
mkdir -p "$dest/debs" "$dest/root"
electron="$(node -e "console.log(require('$repo/node_modules/electron'))")"
missing="$(ldd "$electron" | awk '/not found/ {print $1}')"
pkgs=("$@")
for lib in $missing; do
  case "$lib" in
    libasound.so.2) pkgs+=(libasound2t64) ;;
    libnss3.so|libnssutil3.so|libsmime3.so) pkgs+=(libnss3) ;;
    libgbm.so.1) pkgs+=(libgbm1) ;;
    libatk-1.0.so.0) pkgs+=(libatk1.0-0t64) ;;
    libatk-bridge-2.0.so.0) pkgs+=(libatk-bridge2.0-0t64) ;;
    libcups.so.2) pkgs+=(libcups2t64) ;;
    libgtk-3.so.0) pkgs+=(libgtk-3-0t64) ;;
    libxkbcommon.so.0) pkgs+=(libxkbcommon0) ;;
    *) echo "warning: no package mapping for $lib" >&2 ;;
  esac
done
if [ ${#pkgs[@]} -eq 0 ]; then echo "nothing missing"; exit 0; fi
cd "$dest/debs"
apt-get download "${pkgs[@]}"
for d in "$dest"/debs/*.deb; do dpkg -x "$d" "$dest/root"; done
echo "extracted into $dest/root"
LD_LIBRARY_PATH="$dest/root/usr/lib/x86_64-linux-gnu" ldd "$electron" | grep "not found" || echo "all Electron libraries resolved"
