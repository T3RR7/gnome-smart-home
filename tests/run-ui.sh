#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ ${1:-} != --isolated ]]; then
    exec dbus-run-session -- bash tests/run-ui.sh --isolated
fi
test_root=$(mktemp -d -t gnome-smart-home-test.XXXXXX)
cleanup() {
    if [[ -n ${keyring_pid:-} ]]; then kill "$keyring_pid" 2>/dev/null || true; fi
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
gnome-keyring-daemon --foreground --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" <<< 'gnome-smart-home-disposable-test-keyring' &
keyring_pid=$!
bash scripts/build.sh

unset DISPLAY
export LIBGL_ALWAYS_SOFTWARE=1
export GTK_A11Y=none
timeout 90s gnome-shell-test-tool --headless --disable-animations --extra-filter=org.gnome.SmartHome.Test --extra-filter=org.gnome.SmartHome.ColorPicker --extension dist/gnome-smart-home@local.shell-extension.zip "$PWD/tests/shell.js"
