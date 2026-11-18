#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
while IFS= read -r file; do
    node --check "$file"
done < <(find . -path ./node_modules -prune -o -path ./dist -prune -o -name '*.js' -print)
glib-compile-schemas --strict --dry-run schemas
msgfmt --check po/ru.po -o /dev/null
bash scripts/test.sh
