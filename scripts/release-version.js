// SPDX-License-Identifier: MIT
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';

const metadataPath = 'metadata.json';
const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const {version} = JSON.parse(readFileSync('package.json', 'utf8'));

function releaseTag(value) {
    if (!stableVersion.test(value))
        throw new Error(`Expected a release version in MAJOR.MINOR.PATCH form, got ${value}`);
    return `v${value}`;
}

// npm owns the version commit and annotated tag. These hooks validate the bump
// before npm writes anything and stage the GNOME metadata alongside package.json.
try {
    switch (process.argv[2]) {
    case 'preversion': {
        releaseTag(version);
        if (metadata['version-name'] !== version)
            throw new Error('Match metadata.json version-name to package.json before releasing');
        const tag = releaseTag(process.env.npm_new_version);
        if (execFileSync('git', ['tag', '--list', tag], {encoding: 'utf8'}).trim())
            throw new Error(`Tag ${tag} already exists`);
        break;
    }
    case 'version':
        releaseTag(version);
        metadata['version-name'] = version;
        writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
        execFileSync('git', ['add', '--', metadataPath]);
        break;
    case 'verify-tag': {
        const tag = releaseTag(version);
        if (process.argv[3] !== tag || metadata['version-name'] !== version)
            throw new Error(`Expected tag ${tag} and metadata.json version-name ${version}`);
        break;
    }
    default:
        throw new Error('Expected preversion, version, or verify-tag');
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
