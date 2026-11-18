#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
bash scripts/build.sh
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
