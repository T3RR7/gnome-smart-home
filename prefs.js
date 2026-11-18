// SPDX-License-Identifier: GPL-3.0-or-later
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {Preferences} from './lib/preferences.js';

export default class GnomeSmartHomePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window._smartHomePreferences = new Preferences(window, this.getSettings(), _);
    }
}
