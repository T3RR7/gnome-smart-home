// SPDX-License-Identifier: GPL-3.0-or-later
// GTK runs in its own process; GTK and GNOME Shell's St toolkit cannot be mixed.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

export const ColorPickerApplication = GObject.registerClass(
class GshColorPickerApplication extends Adw.Application {
    _init(initialRgb = [255, 255, 255], title = 'Light color') {
        super._init({application_id: 'org.gnome.SmartHome.ColorPicker', flags: Gio.ApplicationFlags.NON_UNIQUE});
        this._initial = initialRgb;
        this._title = title;
        this.result = null;
        this.failed = false;
    }

    vfunc_activate() {
        this.hold();
        const [red, green, blue] = this._initial.map(value => Math.min(255, Math.max(0, value)) / 255);
        const initial = new Gdk.RGBA({red, green, blue, alpha: 1});
        this.dialog = new Gtk.ColorChooserDialog({
            application: this, title: this._title, modal: true,
            use_alpha: false, show_editor: true,
        });
        this.dialog.set_rgba(initial);
        this.dialog.connect('response', (dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                const selected = dialog.get_rgba();
                this.result = [selected.red, selected.green, selected.blue].map(value => Math.round(value * 255));
            }
            dialog.destroy();
            this.release();
            this.quit();
        });
        this.dialog.present();
    }
});
