// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const uuid = 'gnome-smart-home@local';
const schemaDirectory = `${GLib.get_user_data_dir()}/gnome-shell/extensions/${uuid}/schemas`;
const source = Gio.SettingsSchemaSource.new_from_directory(schemaDirectory, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.gnome-smart-home', false)});
if (settings.get_string('server-url') !== ARGV[0])
    throw new Error('Preferences did not inherit the preview profile');
const devices = JSON.parse(settings.get_string('devices'));
devices[0].name = 'Preview rename';
devices.pop();
settings.set_string('devices', JSON.stringify(devices));
Gio.Settings.sync();
print('PASS preview: separate process reads demo connection and writes favorites');
System.exit(0);
