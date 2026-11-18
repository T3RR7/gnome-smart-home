#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
glib-compile-schemas --strict schemas
mkdir -p dist locale/ru/LC_MESSAGES
msgfmt --check po/ru.po -o locale/ru/LC_MESSAGES/gnome-smart-home.mo
gnome-extensions pack --force --out-dir=dist --extra-source=lib --extra-source=icons --extra-source=locale --extra-source=LICENSE
printf 'Built %s/dist/gnome-smart-home@local.shell-extension.zip\n' "$PWD"
