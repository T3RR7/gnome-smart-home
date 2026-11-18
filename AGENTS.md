# Gnome Smart Home contributor guide

## Project

Gnome Smart Home is a GJS extension for GNOME Shell 46–51 on Wayland. It controls selected Home Assistant entities from Quick Settings. The [README](README.md) covers installation, configuration, and supported devices.

## Where to make changes

- `extension.js` manages the Shell tile, settings subscriptions, and connection lifecycle. `lib/controls.js` owns the device widgets and command feedback.
- `prefs.js` and `lib/preferences.js` handle the GTK 4/libadwaita settings. `lib/color-picker.js` draws the inline color wheel in Quick Settings. Keep GTK imports out of the Shell process.
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
- Install the development dependencies in a Python 3.12 or newer virtual environment with `python -m pip install -r requirements-lint.txt`. Run `make lint` there to build and analyze the release ZIP with [Shexli](https://gitlab.gnome.org/Infrastructure/extensions-web/-/tree/master/shexli). To select the interpreter directly, use `make lint PYTHON=/path/to/venv/bin/python`.
- Use `make test-ui` for Shell or GTK changes. It runs headlessly with GNOME Keyring or oo7 in an isolated profile. Test the relevant Shell versions when changing compatibility.
- Use `make dev` for manual UI checks in the isolated Devkit and `make test-preview` for demo launch or preference synchronization changes. These targets use the GNOME Shell 50 or later developer tools. Restart the preview to load code changes. Use `make build` to package the ZIP and `make install` when installing into the current user's GNOME profile.
- For documentation edits, verify links and commands against the repository. In your handoff, report the checks you ran and any verification gaps.

## Release to GNOME Extensions

- With npm and `flock` installed and the working tree clean, run `make release` for a patch release. Use `make release BUMP=minor` or `make release BUMP=major` for other bumps. The command updates `package.json` and `metadata.json`, commits them, and pushes the release commit and annotated `vMAJOR.MINOR.PATCH` tag to `origin` in one Git transaction. If the push fails, run `make release` again from the same branch to retry that release.
- Read the [review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html) and the [upload terms](https://extensions.gnome.org/upload/). Running `make release` pushes the tag that authorizes [Publish to GNOME Extensions](.github/workflows/publish-gnome-extensions.yml) to accept those terms and send the ZIP for review with the `EGO_USERNAME` and `EGO_PASSWORD` repository secrets. Only a new release tag triggers this workflow.
- The workflow runs Shexli against the same ZIP it submits. Errors stop the workflow. Review warnings before submitting.
- Check the GNOME Extensions account for the submitted version before retrying a timed-out upload. To submit manually, download the ZIP from the workflow's artifacts and use the [upload page](https://extensions.gnome.org/upload/).
