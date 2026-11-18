import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';

test('thematic GNOME icons preserve the original upstream SVG bytes', () => {
    const manifest = JSON.parse(readFileSync(new URL('../icons/manifest.json', import.meta.url)));
    assert.equal(manifest.license, 'CC0-1.0');
    for (const icon of manifest.icons) {
        const file = readFileSync(new URL(`../${icon.file}`, import.meta.url));
        assert.equal(createHash('sha256').update(file).digest('hex'), icon.sha256, icon.file);
        assert.ok(icon.source.startsWith(`${manifest.repository}/-/blob/${manifest.revision}/`));
    }
});
