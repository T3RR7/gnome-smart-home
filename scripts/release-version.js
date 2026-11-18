// SPDX-License-Identifier: MIT
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';

const metadataPath = 'metadata.json';
const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const version = packageVersion();

function packageVersion() {
    return JSON.parse(readFileSync('package.json', 'utf8')).version;
}

function releaseTag(value) {
    if (!stableVersion.test(value))
        throw new Error(`Expected a release version in MAJOR.MINOR.PATCH form, got ${value}`);
    return `v${value}`;
}

/** Create a release and push its commit and tag together. Retry the pending push on failure. */
function publishRelease(bump) {
    if (!['patch', 'minor', 'major'].includes(bump))
        throw new Error('Set BUMP to patch, minor, or major');

    const branch = execFileSync('git', ['symbolic-ref', 'HEAD'], {encoding: 'utf8'}).trim();
    const pendingPath = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path',
        'gnome-smart-home-pending-release.json'], {encoding: 'utf8'}).trim();
    let pending;
    if (existsSync(pendingPath)) {
        pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
        if (pending.branch !== branch)
            throw new Error(`Resume the pending release ${pending.tag} from ${pending.branch}`);
        console.log(`Retrying the push for ${pending.tag}`);
    } else {
        execFileSync('git', ['remote', 'get-url', '--push', 'origin']);
        execFileSync('npm', ['version', bump, '--force=false', '--git-tag-version', '--ignore-scripts=false',
            '--tag-version-prefix=v', '--message', 'Release %s'], {stdio: 'inherit'});
        pending = {branch, tag: releaseTag(packageVersion())};
        writeFileSync(pendingPath, `${JSON.stringify(pending)}\n`);
    }

    const tagRef = `refs/tags/${pending.tag}`;
    execFileSync('git', ['push', '--atomic', '--no-follow-tags', 'origin',
        `${tagRef}^{commit}:${pending.branch}`, tagRef], {stdio: 'inherit'});
    rmSync(pendingPath);
}

// npm owns the version commit and annotated tag. These hooks validate the bump
// before npm writes anything and stage the GNOME metadata alongside package.json.
try {
    switch (process.argv[2]) {
    case 'release':
        publishRelease(process.argv[3]);
        break;
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
        throw new Error('Expected release, preversion, version, or verify-tag');
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
