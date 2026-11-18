// SPDX-License-Identifier: MIT
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';
import {ColorPickerApplication} from '../lib/color-picker.js';

for (const cancel of [false, true]) {
    const app = new ColorPickerApplication([255, 0, 0], 'Test light color');
    let responded = false;
    let attempts = 0;
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
        if (++attempts > 300) {
            printerr('Color chooser did not appear');
            System.exit(1);
        }
        const windows = Gtk.Window.get_toplevels();
        for (let index = 0; index < windows.get_n_items(); index++) {
            const window = windows.get_item(index);
            if (!(window instanceof Gtk.ColorChooserDialog) || !window.visible)
                continue;
            if (!window.show_editor || window.use_alpha)
                throw new Error('The picker must open the full opaque-color editor');
            if (!cancel)
                window.set_rgba(new Gdk.RGBA({red: 12 / 255, green: 133 / 255, blue: 212 / 255, alpha: 1}));
            window.response(cancel ? Gtk.ResponseType.CANCEL : Gtk.ResponseType.OK);
            responded = true;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
    app.run([]);
    if (!responded)
        GLib.Source.remove(timer);
    if (!responded || (cancel ? app.result !== null : JSON.stringify(app.result) !== '[12,133,212]'))
        throw new Error('Native color chooser returned an incorrect result');
    print(cancel ? 'PASS native color chooser cancellation' : 'PASS native color chooser accepts an arbitrary RGB color');
}
