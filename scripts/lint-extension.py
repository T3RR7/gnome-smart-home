# SPDX-License-Identifier: MIT
"""Report Shexli findings for a release ZIP and fail on analyzer errors."""

import argparse

from shexli import analyze_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', help='Path to the built GNOME Shell extension ZIP')
    args = parser.parse_args()

    report = analyze_path(args.archive)
    errors = 0
    for finding in report.findings:
        print(f'[{finding.severity}] {finding.rule_id} {finding.message}')
        for evidence in finding.evidence:
            line = f':{evidence.line}' if evidence.line is not None else ''
            print(f'  {evidence.path}{line}')
        if finding.source_url:
            print(f'  {finding.source_url}')
        errors += finding.severity == 'error'

    print(f'Shexli findings: {len(report.findings)} total, {errors} with error severity')
    return int(errors > 0)


if __name__ == '__main__':
    raise SystemExit(main())
