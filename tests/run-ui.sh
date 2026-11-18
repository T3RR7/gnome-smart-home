#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ ${1:-} != --isolated ]]; then
    exec dbus-run-session -- bash tests/run-ui.sh --isolated
fi
test_root=$(mktemp -d -t gnome-smart-home-test.XXXXXX)
cleanup() {
    if [[ -n ${keyring_pid:-} ]]; then
        kill "$keyring_pid" 2>/dev/null || true
        wait "$keyring_pid" 2>/dev/null || true
    fi
    rm -rf -- "$test_root"
}
trap cleanup EXIT
export XDG_DATA_HOME="$test_root/data"
export XDG_CONFIG_HOME="$test_root/config"
export XDG_CACHE_HOME="$test_root/cache"
export GNOME_KEYRING_CONTROL="$test_root/keyring"
export XDG_RUNTIME_DIR="$test_root/runtime"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
mkdir -m 700 "$GNOME_KEYRING_CONTROL"
mkdir -m 700 "$XDG_RUNTIME_DIR"
bash scripts/test-keyring.sh "$GNOME_KEYRING_CONTROL" &
keyring_pid=$!
gdbus wait --session --timeout 10 org.freedesktop.secrets
bash scripts/build.sh

unset DISPLAY
export LIBGL_ALWAYS_SOFTWARE=1
export GTK_A11Y=none
# Keep GTK in the isolated Wayland session without probing Xwayland or GVfs.
export GSK_RENDERER=cairo
export GIO_USE_VFS=local
export GTK_IM_MODULE=simple
export PATH="$PWD/tests:$PATH"
archive=dist/gnome-smart-home@local.shell-extension.zip
runner=(gnome-shell-test-tool --wrap wayland-shell --headless --extra-filter=org.gnome.SmartHome.Test)
if [[ $(gnome-shell-test-tool --help) == *--extension* ]]; then
    runner+=(--disable-animations --extension "$archive")
else
    # Before GNOME 50, the test tool inherits the isolated profile above.
    export GSETTINGS_BACKEND=keyfile
    gnome-extensions install "$archive"
    gsettings set org.gnome.shell enabled-extensions "['gnome-smart-home@local']"
fi
timeout 90s "${runner[@]}" "$PWD/tests/shell.js"
