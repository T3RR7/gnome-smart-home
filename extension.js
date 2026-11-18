// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {HomeAssistantClient} from './lib/client.js';
import {lookupToken} from './lib/credentials.js';
import {DeviceControl, ScrollableSection} from './lib/controls.js';
import {isOn, parseDevices} from './lib/model.js';
import {ShellIcons} from './lib/icons.js';

const HomeToggle = GObject.registerClass(
class GshHomeToggle extends QuickSettings.QuickMenuToggle {
    _init(extension) {
        super._init({title: _('Smart Home'), iconName: 'go-home-symbolic', toggleMode: false});
        this.menu.setHeader('go-home-symbolic', _('Smart Home'), 'Home Assistant');
        this.connect('clicked', () => this.menu.isOpen ? this.menu.close() : this.menu.open());

        this._statusItem = new PopupMenu.PopupMenuItem(_('Set up Home Assistant'), {reactive: false});
        this.menu.addMenuItem(this._statusItem);
        this._devicesSection = new ScrollableSection();
        this.menu.addMenuItem(this._devicesSection);
        this._empty = new PopupMenu.PopupMenuItem(_('Choose devices in Settings'), {reactive: false});
        this.menu.addMenuItem(this._empty);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._retryItem = this.menu.addAction(_('Reconnect'), () => extension.reconnect(), 'view-refresh-symbolic');
        this._openItem = this.menu.addAction(_('Open Home Assistant'), () => extension.openHomeAssistant(), 'web-browser-symbolic');
        const settingsItem = this.menu.addAction(_('Settings'), () => {
            Main.panel.closeQuickSettings();
            extension.openPreferences();
        }, 'emblem-system-symbolic');
        settingsItem.visible = Main.sessionMode.allowSettings;
        this.menu._settingsActions[extension.uuid] = settingsItem;
        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this.resizeDeviceList();
            else {
                extension.closeColorPickers();
                this._devicesSection.cancelReveal();
            }
        });
    }

    destroy() {
        this.menu.disconnect(this._menuOpenId);
        this._menuOpenId = 0;
        this._statusItem.destroy();
        this._statusItem = null;
        this._empty.destroy();
        this._empty = null;
        // QuickMenuToggle owns the menu and destroys its remaining rows.
        super.destroy();
    }

    resizeDeviceList(colorPickerOpen = false) {
        const monitor = Main.layoutManager.findMonitorForActor(this) ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const [, sourceY] = this.get_transformed_position();
        const listHeight = this._devicesSection.actor.height;
        const menuHeight = this.menu.box.height;
        const chrome = Math.max(224, menuHeight - listHeight);
        const available = (monitor.y ?? 0) + monitor.height - sourceY - this.height - chrome - 28;
        const limit = Number.isFinite(available) ? available : 160;
        const maxHeight = colorPickerOpen ? 390 : 320;
        const style = `min-height: 0px; max-height: ${Math.max(96, Math.min(maxHeight, Math.floor(limit)))}px;`;
        if (this._devicesSection.actor.style !== style)
            this._devicesSection.actor.style = style;
    }
});

export default class GnomeSmartHome extends Extension {
    // Keep this monotonic across enable/disable cycles to reject stale lookups.
    _generation = 0;

    enable() {
        this._settings = this.getSettings();
        this._active = true;
        this._states = new Map();
        this._status = 'unconfigured';
        this._controls = [];
        this._icons = new ShellIcons();
        this._indicator = new QuickSettings.SystemIndicator();
        this._panelIcon = this._indicator._addIndicator();
        this._panelIcon.icon_name = 'go-home-symbolic';
        this._settings.bind('show-indicator', this._panelIcon, 'visible', Gio.SettingsBindFlags.GET);
        this._toggle = new HomeToggle(this);
        this._indicator.quickSettingsItems.push(this._toggle);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator, 2);
        this._defaultTileSibling = this._toggle.get_next_sibling();
        this._defaultTilePrevious = this._toggle.get_previous_sibling();

        this._settingsSignals = [
            this._settings.connect('changed::server-url', () => this.reconnect()),
            this._settings.connect('changed::credential-revision', () => this.reconnect()),
            this._settings.connect('changed::devices', () => {
                const before = this._favorites.map(favorite => favorite.id).sort().join(',');
                this._buildControls();
                const after = this._favorites.map(favorite => favorite.id).sort().join(',');
                if (before !== after)
                    this.reconnect();
            }),
            this._settings.connect('changed::show-sliders', () => this._buildControls()),
            this._settings.connect('changed::show-color-controls', () => this._buildControls()),
            this._settings.connect('changed::tile-icon', () => this._syncTileIcon()),
            this._settings.connect('changed::tile-position', () => this._positionTile()),
        ];
        this._syncTileIcon();
        this._positionTile();
        this._buildControls();
        this.reconnect();
    }

    _buildControls() {
        this._toggle._devicesSection.cancelReveal();
        for (const control of this._controls)
            control.destroy();
        this._favorites = parseDevices(this._settings.get_string('devices'));
        this._controls = this._favorites.map(favorite => {
            const control = new DeviceControl(favorite, {
                icons: this._icons,
                showSliders: this._settings.get_boolean('show-sliders'),
                showColors: this._settings.get_boolean('show-color-controls'),
                runCommand: command => this._runCommand(command),
                onColorToggled: (row, expanded) => this._updateColorDropdown(control, row, expanded),
            });
            this._toggle._devicesSection.addMenuItem(control.section);
            return control;
        });
        if (this._toggle.menu.isOpen)
            this._toggle.resizeDeviceList();
        this._sync();
    }

    // Keep one picker open and leave room for the controls above it.
    _updateColorDropdown(control, row, expanded) {
        if (!this._toggle.menu.isOpen)
            return;
        if (expanded)
            this.closeColorPickers(control);
        this._toggle.resizeDeviceList(this._controls.some(item => item.colorPickerOpen));
        if (expanded)
            this._toggle._devicesSection.reveal(row);
    }

    closeColorPickers(except = null) {
        for (const control of this._controls) {
            if (control !== except)
                control.closeColorPicker();
        }
    }

    async _syncTileIcon() {
        const icons = this._icons;
        const choice = this._settings.get_string('tile-icon') || 'go-home-symbolic';
        const icon = await icons.resolve(choice, 'home');
        // A later settings change or disable may supersede this lookup.
        if (!icon || icons !== this._icons || choice !== (this._settings.get_string('tile-icon') || 'go-home-symbolic'))
            return;
        this._toggle.gicon = icon;
        this._panelIcon.gicon = icon;
        this._toggle.menu.setHeader(icon, _('Smart Home'), 'Home Assistant');
    }

    _positionTile() {
        const position = this._settings.get_uint('tile-position');
        const grid = this._toggle.get_parent();
        if (!grid)
            return;
        if (!position) {
            if (grid.get_children().includes(this._defaultTileSibling))
                grid.set_child_below_sibling(this._toggle, this._defaultTileSibling);
            else if (grid.get_children().includes(this._defaultTilePrevious))
                grid.set_child_above_sibling(this._toggle, this._defaultTilePrevious);
            return;
        }
        const siblings = grid.get_children().filter(child => child !== this._toggle && child.visible &&
            child instanceof QuickSettings.QuickSettingsItem);
        const sibling = siblings[position - 1];
        if (sibling)
            grid.set_child_below_sibling(this._toggle, sibling);
        else
            grid.set_child_above_sibling(this._toggle, siblings.at(-1) ?? null);
    }

    async reconnect() {
        const generation = ++this._generation;
        this._client?.stop();
        this._client = null;
        this._credentialCancel?.cancel();
        this._credentialCancel = new Gio.Cancellable();
        this._states.clear();
        const url = this._settings.get_string('server-url');
        this._status = url ? 'connecting' : 'unconfigured';
        this._sync();
        if (!url)
            return;
        try {
            const token = await lookupToken(url, this._credentialCancel);
            if (!this._active || generation !== this._generation)
                return;
            if (!token) {
                this._status = 'no-token';
                this._sync();
                return;
            }
            this._client = new HomeAssistantClient({
                url, token, entityIds: this._favorites.map(favorite => favorite.id),
                onStatus: status => {
                    if (!this._active || generation !== this._generation)
                        return;
                    this._status = status;
                    this._sync();
                },
                onStates: states => {
                    if (!this._active || generation !== this._generation)
                        return;
                    this._states = states;
                    this._sync();
                },
            });
            this._client.start();
        } catch {
            if (this._active && generation === this._generation) {
                this._status = 'keyring-error';
                this._sync();
            }
        }
    }

    _sync() {
        const connected = this._status === 'connected';
        const messages = {
            unconfigured: _('Set up Home Assistant'),
            connecting: _('Connecting…'),
            connected: _('Connected'),
            offline: _('Offline · reconnecting automatically'),
            'auth-error': _('Access token rejected · check Settings'),
            'permission-error': _('Access denied · check Settings'),
            'no-token': _('Add an access token in Settings'),
            'keyring-error': _('Could not read the GNOME keyring'),
        };
        const activeCount = this._favorites.filter(favorite => isOn(this._states.get(favorite.id))).length;
        this._toggle.subtitle = connected
            ? this._favorites.length ? `${activeCount} / ${this._favorites.length} · ${_('Active')}` : _('Choose devices')
            : this._status === 'connecting' ? _('Connecting…') : this._status === 'unconfigured' ? _('Set up') : _('Not connected');
        this._toggle.checked = connected;
        this._toggle._statusItem.label.text = messages[this._status] ?? _('Not connected');
        this._toggle._empty.visible = !this._favorites.length;
        this._toggle._retryItem.visible = Boolean(this._settings.get_string('server-url')) && !connected;
        this._toggle._openItem.visible = Boolean(this._settings.get_string('server-url'));
        for (const control of this._controls)
            control.update(this._states.get(control.favorite.id), connected);
    }

    async _runCommand(command) {
        try {
            await this._client?.callService(command);
        } catch (error) {
            if (this._active)
                Main.notify(_('Smart Home'), _('The action failed. Check the device and your connection.'));
            throw error;
        }
    }

    openHomeAssistant() {
        const url = this._settings.get_string('server-url');
        if (url) {
            Main.panel.closeQuickSettings();
            Gio.AppInfo.launch_default_for_uri_async(url, global.create_app_launch_context(0, -1), null,
                (_source, result) => {
                    try {
                        Gio.AppInfo.launch_default_for_uri_finish(result);
                    } catch {
                        if (this._active)
                            Main.notify(_('Smart Home'), _('Could not open Home Assistant.'));
                    }
                });
        }
    }

    disable() {
        this._active = false;
        this._generation++;
        this._credentialCancel?.cancel();
        this._credentialCancel = null;
        this._client?.stop();
        this._client = null;
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];
        for (const control of this._controls)
            control.destroy();
        this._controls = [];
        this._icons.destroy();
        this._icons = null;
        for (const item of this._indicator.quickSettingsItems)
            item.destroy();
        this._indicator.destroy();
        this._indicator = null;
        this._toggle = null;
        this._panelIcon = null;
        this._defaultTileSibling = null;
        this._defaultTilePrevious = null;
        this._states = null;
        this._favorites = null;
        this._settings = null;
    }
}
