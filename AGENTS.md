# Gnome Smart Home contributor guide

## Project

Gnome Smart Home is a GJS extension for GNOME Shell 50 on Wayland. It controls selected Home Assistant entities from Quick Settings. The [README](README.md) covers installation, configuration, and supported devices.

## Where to make changes

- `extension.js` manages the Shell tile, settings subscriptions, and connection lifecycle. `lib/controls.js` owns the device widgets and command feedback.
- `prefs.js` and `lib/preferences.js` handle the GTK 4/libadwaita settings. `lib/color-picker*.js` runs the GTK color picker in a separate process. Keep GTK imports out of the Shell process.
- `lib/client.js` handles REST discovery and the WebSocket connection. `lib/model.js` keeps entity capabilities, state updates, and service payloads independent of GNOME modules.
- `lib/credentials.js` stores tokens in the keyring. Keep real tokens, server URLs, and device data out of source files, fixtures, commits, and shared logs. Use the local Home Assistant fixture for automated tests.

## Working conventions

- Keep all AI agent working files outside the repository and out of Git. This includes scratch files, plans, prompts, logs, session state, and tool caches. `AGENTS.md` is maintained project guidance.
- Document all new or changed code in English. Explain each component's purpose and document interfaces, assumptions, and behavior that a reader cannot infer from the code.
- Describe every new feature in `README.md`, including how to use it and any relevant requirements. Update existing README instructions when behavior changes.
- Use English for code, comments, and contributor documentation. Wrap new interface strings with gettext and update `po/ru.po`. Build the translation catalog from the source.
- Prefer native Shell and libadwaita widgets and symbolic icons. Preserve source, license, and checksum records for bundled icons in `icons/manifest.json`.
- Cancel pending work and release signals, timers, widgets, and connections when a component is torn down. Check that programmatic state updates never send device commands.
- Keep stored favorites compatible when changing the settings format. Preserve the extension UUID and schema ID. Keep generated ZIPs, compiled schemas and translation catalogs, and test artifacts out of Git.

## Verification

- Run `make check` for JavaScript, schema and translation validation, unit tests, and local Home Assistant API tests.
- Use `make test-ui` for Shell or GTK changes and `make test-preview` for demo launch or preference synchronization changes.
- Use `make dev` for manual UI checks in the isolated Devkit. Restart the preview to load code changes. Use `make build` to package the ZIP and `make install` when installing into the current user's GNOME profile.
- For documentation edits, verify links and commands against the repository. In your handoff, report the checks you ran and any verification gaps.
