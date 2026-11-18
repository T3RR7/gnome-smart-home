# SPDX-License-Identifier: MIT
.DEFAULT_GOAL := help
.NOTPARALLEL:

UUID := gnome-smart-home@local
PACKAGE := dist/$(UUID).shell-extension.zip
PYTHON ?= python3
BUMP ?= patch

.PHONY: help build install enable disable prefs dev check lint release test test-ui test-preview clean

help:
	@printf '%s\n' \
		'Gnome Smart Home' \
		'' \
		'  make build         Package the extension as an installable ZIP' \
		'  make install       Build, install and enable for the current user' \
		'  make enable        Enable the installed extension' \
		'  make disable       Disable the installed extension' \
		'  make prefs         Open the installed extension preferences' \
		'  make dev           Open an isolated GNOME Devkit preview' \
		'  make check         Validate code, schemas and translations, then run tests' \
		'  make lint          Build and analyze the release ZIP with Shexli' \
		'  make release       Bump, commit, tag, and push a release (BUMP=patch, minor, or major)' \
		'  make test          Run the unit tests and local Home Assistant API tests' \
		'  make test-ui       Run the headless GNOME Shell and GTK tests' \
		'  make test-preview  Check the demo launcher and preferences integration' \
		'  make clean         Remove the ZIP, compiled schema and translation catalog'

build:
	bash scripts/build.sh

install:
	bash scripts/install.sh

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

dev:
	bash scripts/dev.sh

check:
	bash scripts/check.sh

lint: build
	$(PYTHON) scripts/lint-extension.py '$(PACKAGE)'

release: export RELEASE_BUMP = $(BUMP)
release:
	@git_dir=$$(git rev-parse --path-format=absolute --git-common-dir) && \
		flock "$$git_dir/gnome-smart-home-release.lock" node scripts/release-version.js release "$$RELEASE_BUMP"

test:
	bash scripts/test.sh

test-ui:
	bash tests/run-ui.sh

test-preview:
	GSH_PREVIEW_SMOKE=1 bash scripts/dev.sh --headless

clean:
	rm -f -- $(PACKAGE) schemas/gschemas.compiled locale/ru/LC_MESSAGES/gnome-smart-home.mo
