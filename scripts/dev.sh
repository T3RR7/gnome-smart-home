#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ ${1:-} != --isolated ]]; then
    exec dbus-run-session -- bash scripts/dev.sh --isolated "$@"
fi
shift
mode=--devkit
case ${1:-} in
    '') ;;
    --headless) mode=--headless ;;
    *) printf 'Usage: bash scripts/dev.sh [--headless]\n' >&2; exit 2 ;;
esac

preview_root=$(mktemp -d -t gnome-smart-home-preview.XXXXXX)
cleanup() {
    if [[ -n ${keyring_pid:-} ]]; then
        kill "$keyring_pid" 2>/dev/null || true
        wait "$keyring_pid" 2>/dev/null || true
    fi
    rm -rf -- "$preview_root"
}
trap cleanup EXIT
export XDG_DATA_HOME="$preview_root/data"
export XDG_CONFIG_HOME="$preview_root/config"
export XDG_CACHE_HOME="$preview_root/cache"
export GNOME_KEYRING_CONTROL="$preview_root/keyring"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" tests/artifacts
mkdir -m 700 "$GNOME_KEYRING_CONTROL"
gnome-keyring-daemon --foreground --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" <<< 'gnome-smart-home-disposable-preview-keyring' &
keyring_pid=$!
bash scripts/build.sh

export LIBGL_ALWAYS_SOFTWARE=1
export GTK_A11Y=none
printf '\nStarting Gnome Smart Home UI preview with demo devices.\n'
printf 'Open Quick Settings → Smart Home → Settings inside the Devkit window.\n'
printf 'Stop with Ctrl+C. After editing code, run this command again.\n'
printf 'Log: %s/tests/artifacts/devkit.log\n\n' "$PWD"
runner=(gnome-shell-test-tool "$mode" --extra-filter=org.gnome.Shell.Extensions --extra-filter=org.gnome.SmartHome.ColorPicker --extension dist/gnome-smart-home@local.shell-extension.zip "$PWD/tests/preview.js")
if [[ ${GSH_PREVIEW_SMOKE:-0} == 1 ]]; then
    timeout 90s "${runner[@]}" 2>&1 | tee tests/artifacts/devkit.log
else
    "${runner[@]}" 2>&1 | tee tests/artifacts/devkit.log
fi
