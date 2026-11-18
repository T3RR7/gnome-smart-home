#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Run a disposable Secret Service on the caller's isolated D-Bus session.
set -euo pipefail

keyring_dir=$1
password=gnome-smart-home-disposable-test-keyring
if command -v gnome-keyring-daemon >/dev/null; then
    exec gnome-keyring-daemon --foreground --unlock --components=secrets \
        --control-directory="$keyring_dir" <<< "$password"
fi

daemon=$(command -v oo7-daemon || true)
if [[ -z $daemon && -x /usr/libexec/oo7-daemon ]]; then
    daemon=/usr/libexec/oo7-daemon
fi
if [[ -z $daemon ]]; then
    printf 'Install GNOME Keyring or oo7 to run the isolated UI.\n' >&2
    exit 1
fi

# The PAM socket must be private even when Devkit shares the desktop runtime directory.
export OO7_PAM_SOCKET="$keyring_dir/pam.sock"
exec "$daemon" --login <<< "$password"
