#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
bash scripts/build.sh
# GNOME moves the unpacked bundle from its cache to the extensions directory.
# Place the temporary cache on the data filesystem so that move can succeed.
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell"
mkdir -p -- "$data_dir"
install_cache=$(mktemp -d "$data_dir/.gsh-install.XXXXXX")
trap 'rmdir -- "$install_cache" 2>/dev/null || true' EXIT
XDG_CACHE_HOME="$install_cache" GIO_USE_VFS=local \
    gnome-extensions install --force dist/gnome-smart-home@local.shell-extension.zip
if gnome-extensions info gnome-smart-home@local >/dev/null 2>&1; then
    gnome-extensions enable gnome-smart-home@local
    printf 'Enabled Gnome Smart Home. Open the top-right Quick Settings menu.\n'
else
    # A running Wayland Shell does not discover new local extensions until login.
    # Enable this UUID for the next session without changing any other extension.
    gjs -c '
        const {Gio} = imports.gi;
        const settings = new Gio.Settings({schema_id: "org.gnome.shell"});
        const uuid = "gnome-smart-home@local";
        const enabled = settings.get_strv("enabled-extensions");
        if (!enabled.includes(uuid))
            settings.set_strv("enabled-extensions", [...enabled, uuid]);
        settings.set_strv("disabled-extensions", settings.get_strv("disabled-extensions").filter(id => id !== uuid));
        Gio.Settings.sync();
    '
    printf 'Installed and enabled for the next login. Log out and back in to load Gnome Smart Home.\n'
fi
