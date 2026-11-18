# Icon sources

The SVG files under `gnome/` are original assets by Jakub Steiner from the
[GNOME Icon Development Kit](https://gitlab.gnome.org/Teams/Design/icon-development-kit),
licensed under CC0-1.0. They are not drawn or redesigned for this extension.

The file bytes are unchanged and filenames use the `-symbolic` suffix. GTK uses
these files directly. GNOME Shell recolors SVG fills, so the extension caches a
symbolic SVG that uses the original silhouette as its alpha mask. This preserves
the source strokes and lets the Shell theme color the entire icon.

`manifest.json` records the exact upstream revision, source paths, URLs, and
SHA-256 hashes. The upstream license text is included in `gnome/COPYING.md`.

Other stock GNOME icons are loaded from the system's installed Adwaita theme.
