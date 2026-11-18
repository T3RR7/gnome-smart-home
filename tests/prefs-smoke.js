// SPDX-License-Identifier: MIT
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';
import {Preferences} from '../lib/preferences.js';
import {lookupToken} from '../lib/credentials.js';
import {ICON_CHOICES, importSymbolicIcon, resolveIcon, stockIconFile} from '../lib/icons.js';
import {parseDevices} from '../lib/model.js';
import {startFixture, TEST_TOKEN, waitUntil} from './fixture.js';

const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const schemaSource = Gio.SettingsSchemaSource.new_from_directory(`${root}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
const schema = schemaSource.lookup('org.gnome.shell.extensions.gnome-smart-home', false);
const settings = new Gio.Settings({settings_schema: schema});
const app = new Adw.Application({application_id: 'org.gnome.SmartHome.Test', flags: Gio.ApplicationFlags.NON_UNIQUE});
let exitCode = 0;
function assert(value, message) {
    if (!value)
        throw new Error(message);
}

app.connect('activate', () => {
    const window = new Adw.PreferencesWindow({application: app});
    const prefs = new Preferences(window, settings, text => text);
    window.present();
    const fixture = startFixture();
    async function run() {
        assert(prefs._favoriteRows.length === 0, 'initial empty favorites');
        prefs._url.text = fixture.url;
        prefs._token.text = TEST_TOKEN;
        await prefs._connect(true);
        assert(prefs._status.title === 'Connected', `connection status: ${prefs._status.subtitle}`);
        assert(prefs._catalogRows.length === 7, 'available devices populated');
        assert(await lookupToken(fixture.url) === TEST_TOKEN, 'token saved in keyring');
        assert(prefs._token.text === '', 'token removed from the entry after saving');
        assert(!settings.list_keys().some(key => key.includes('token')), 'token absent from GSettings');
        prefs._checks.get('light.desk').active = true;
        prefs._checks.get('switch.kettle').active = true;
        assert(prefs._favoriteRows.length === 2, 'add favorite devices');
        prefs._move(0, 1);
        assert(parseDevices(settings.get_string('devices'))[0].id === 'switch.kettle', 'persist reordered favorites');
        const theme = Gtk.IconTheme.get_for_display(window.get_display());
        assert(theme.has_icon(prefs._devicesPage.icon_name), 'Devices tab icon is registered with GTK');
        for (const [name] of ICON_CHOICES)
            assert(stockIconFile(name)?.query_exists(null) || theme.has_icon(name), `stock GNOME icon exists: ${name}`);
        const stockIcon = stockIconFile('display-brightness-symbolic');
        const icon = await importSymbolicIcon(stockIcon, null);
        prefs._favorites[0].icon = icon;
        prefs._saveFavorites();
        assert(resolveIcon(parseDevices(settings.get_string('devices'))[0].icon, 'switch.kettle') instanceof Gio.FileIcon, 'custom symbolic SVG is saved and resolves to an icon');
        const picker = prefs._chooseIcon(() => {});
        assert(picker instanceof Adw.Dialog, 'native symbolic icon picker opens');
        picker.close();
        print('PASS GTK symbolic icon import, persistence, and native picker');
        prefs._search.text = 'Desk';
        await waitUntil(() => prefs._catalogRows.length === 2, 'search filters');
        prefs._domainFilter.selected = 1;
        assert(prefs._catalogRows.length === 1, 'device type filter');
        prefs._checks.get('light.desk').active = false;
        assert(prefs._favoriteRows.length === 1, 'remove device from favorites');
        prefs._search.text = '';
        prefs._domainFilter.selected = 0;
        await prefs._forget();
        assert(settings.get_string('server-url') === '', 'forget removes connection settings');
        assert(await lookupToken(fixture.url) === null, 'forget removes token from keyring');
        print('PASS GTK4/libadwaita settings: connect, keyring, device discovery, selection, reordering, search, filtering, forget');
    }
    run().catch(error => { logError(error); exitCode = 1; }).finally(() => {
        fixture.stop();
        window.close();
        app.quit();
    });
});
app.run([]);
System.exit(exitCode);
