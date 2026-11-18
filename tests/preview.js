// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

import {startFixture, TEST_TOKEN, waitUntil} from './fixture.js';

export const METRICS = {};

async function preparePreferencesEnvironment() {
    // D-Bus services must inherit the nested Shell's profile and display, rather
    // than the launcher's outer profile. This opens the real extension prefs.
    const environment = {};
    for (const key of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
        'XDG_RUNTIME_DIR', 'GSETTINGS_BACKEND', 'GNOME_KEYRING_CONTROL', 'GTK_A11Y']) {
        const value = GLib.getenv(key);
        if (value !== null)
            environment[key] = value;
    }
    environment.WAYLAND_DISPLAY = 'gnome-shell-test-display';
    environment.GDK_BACKEND = 'wayland';
    await new Promise((resolve, reject) => {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'UpdateActivationEnvironment',
            new GLib.Variant('(a{ss})', [environment]), null,
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try { connection.call_finish(result); resolve(); } catch (error) { reject(error); }
            });
    });
}

export async function run() {
    await Scripting.waitLeisure();
    const extension = Main.extensionManager.lookup('gnome-smart-home@local');
    if (!extension?.stateObj?._toggle || extension.error)
        throw new Error(`Preview could not load the extension: ${extension?.error ?? 'missing tile'}`);
    const instance = extension.stateObj;
    const fixture = startFixture({onCall: command => {
        print(`[UI preview] ${command.domain}.${command.service} → ${command.target.entity_id} ${JSON.stringify(command.service_data ?? {})}`);
    }});
    const credentials = await import(GLib.filename_to_uri(`${extension.path}/lib/credentials.js`, null));
    try {
        await credentials.storeToken(fixture.url, TEST_TOKEN);
        instance._settings.set_string('devices', JSON.stringify([...fixture.states.keys()].map(id => ({id, name: ''}))));
        instance._settings.set_string('server-url', fixture.url);
        await waitUntil(() => instance._status === 'connected' && instance._states.size === fixture.states.size,
            'demo devices to connect');
        await preparePreferencesEnvironment();
        Main.overview.hide();
        Main.panel.statusArea.quickSettings.menu.open();
        instance._toggle.menu.open();
        await Scripting.waitLeisure();
        print('[UI preview] READY — demo devices connected; the Smart Home menu is open.');
        print('[UI preview] Open Settings from this menu to edit the demo favorites.');

        if (GLib.getenv('GSH_PREVIEW_SMOKE') === '1') {
            instance.openPreferences();
            await waitUntil(() => global.get_window_actors().some(actor =>
                actor.meta_window.get_wm_class() === 'org.gnome.Shell.Extensions'),
            'real extension preferences to appear inside the nested GNOME', 20000);
            print('PASS preview: real extension preferences open on the nested display');
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE});
            launcher.setenv('GDK_BACKEND', 'wayland', true);
            launcher.setenv('WAYLAND_DISPLAY', 'gnome-shell-test-display', true);
            const prefsPath = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('preview-smoke.js').get_path();
            const child = launcher.spawnv(['gjs', '-m', prefsPath, fixture.url]);
            await new Promise((resolve, reject) => {
                child.communicate_utf8_async(null, null, (process, result) => {
                    try {
                        const [, stdout] = process.communicate_utf8_finish(result);
                        print(stdout.trim());
                        if (!process.get_successful())
                            throw new Error('Preview settings synchronization failed');
                        resolve();
                    } catch (error) { reject(error); }
                });
            });
            await waitUntil(() => instance._favorites.length === 6 && instance._favorites[0].name === 'Preview rename',
                'cross-process preferences changes to reach the extension');
            print('PASS preview: native settings share favorites with the nested Shell');
            return;
        }
        // Keep the fixture and automation alive while the person uses Devkit.
        await new Promise(() => {});
    } finally {
        await credentials.clearToken(fixture.url);
        fixture.stop();
    }
}
