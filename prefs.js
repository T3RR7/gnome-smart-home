// SPDX-License-Identifier: MIT
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {Preferences} from './lib/preferences.js';

export default class GnomeSmartHomePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window._smartHomePreferences = new Preferences(window, this.getSettings(), _);
    }
}
