// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import Gettext from 'gettext';
import System from 'system';
import {ColorPickerApplication} from './color-picker.js';

const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
Gettext.bindtextdomain('gnome-smart-home', `${root}/locale`);
const _ = Gettext.domain('gnome-smart-home').gettext;
let initial;
try {
    initial = JSON.parse(ARGV[0] ?? '[255,255,255]');
    if (!Array.isArray(initial) || initial.length !== 3 || !initial.every(Number.isFinite))
        throw new Error('invalid-color');
} catch {
    System.exit(1);
}
const app = new ColorPickerApplication(initial, _('Light color'));
const exitCode = app.run([]);
// An empty result means the user cancelled the dialog.
if (app.result)
    print(JSON.stringify(app.result));
System.exit(exitCode);
