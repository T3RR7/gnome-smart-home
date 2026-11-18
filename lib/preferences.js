// SPDX-License-Identifier: MIT
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {discoverEntities, validateUrl} from './client.js';
import {clearToken, lookupToken, storeToken} from './credentials.js';
import {domainOf, entityName, parseDevices, SUPPORTED_DOMAINS} from './model.js';
import {ICON_CHOICES, ICON_DIRECTORY, importSymbolicIcon, resolveIcon} from './icons.js';

// Kept independent of the extension host so the real GTK UI can be smoke-tested.
/** Loads the entity catalog and writes preferences shared with GNOME Shell. */
export class Preferences {
    constructor(window, settings, gettext) {
        this._window = window;
        this._settings = settings;
        Gtk.IconTheme.get_for_display(window.get_display()).add_search_path(ICON_DIRECTORY);
        this._ = gettext;
        this._closed = false;
        this._busy = false;
        this._entities = [];
        this._catalogRows = [];
        this._favoriteRows = [];
        this._checks = new Map();
        this._favorites = parseDevices(settings.get_string('devices'));
        this._cancel = new Gio.Cancellable();
        window.set_default_size(700, 760);
        window.search_enabled = false;
        this._buildConnection();
        this._buildDevices();
        window.connect('close-request', () => {
            this._closed = true;
            this._cancel.cancel();
            if (this._searchTimer)
                GLib.Source.remove(this._searchTimer);
            this._token.text = '';
            return false;
        });
        this._renderFavorites();
        this._renderCatalog();
        this._loadSaved();
    }

    _buildConnection() {
        const _ = this._;
        const page = new Adw.PreferencesPage({title: _('Connection'), icon_name: 'network-server-symbolic'});
        this._window.add(page);
        const group = new Adw.PreferencesGroup({
            title: 'Home Assistant',
            description: _('Connect to your Home Assistant server to choose and control devices.'),
        });
        page.add(group);
        this._url = new Adw.EntryRow({title: _('Server URL'), text: this._settings.get_string('server-url')});
        this._url.input_purpose = Gtk.InputPurpose.URL;
        group.add(this._url);
        this._token = new Adw.PasswordEntryRow({title: _('Long-lived access token')});
        group.add(this._token);
        const help = new Adw.ActionRow({
            title: _('Your token stays in the GNOME keyring'),
            subtitle: _('Create it in Home Assistant → Profile → Security. Leave the token field empty to keep the saved token for this URL.'),
            subtitle_lines: 0,
        });
        help.add_prefix(new Gtk.Image({icon_name: 'changes-prevent-symbolic'}));
        group.add(help);
        this._status = new Adw.ActionRow({title: _('Not connected'), subtitle: _('Example: http://homeassistant.local:8123')});
        this._spinner = new Gtk.Spinner({valign: Gtk.Align.CENTER});
        this._status.add_prefix(this._spinner);
        this._connectButton = new Gtk.Button({label: _('Save and connect'), valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        this._connectButton.connect('clicked', () => this._connect(true));
        this._status.add_suffix(this._connectButton);
        group.add(this._status);
        this._forgetRow = new Adw.ActionRow({title: _('Forget connection'), subtitle: _('Remove this server’s saved token from the keyring.')});
        this._forgetButton = new Gtk.Button({label: _('Forget'), valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
        this._forgetButton.connect('clicked', () => this._forget());
        this._forgetRow.add_suffix(this._forgetButton);
        this._forgetRow.visible = Boolean(this._settings.get_string('server-url'));
        group.add(this._forgetRow);

        const appearance = new Adw.PreferencesGroup({title: _('Panel')});
        page.add(appearance);
        const indicator = new Adw.SwitchRow({title: _('Show panel icon'), subtitle: _('Add a home icon next to the system indicators.')});
        this._settings.bind('show-indicator', indicator, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(indicator);
        const sliders = new Adw.SwitchRow({title: _('Show sliders'), subtitle: _('Brightness, fan speed, and cover position when supported.')});
        this._settings.bind('show-sliders', sliders, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(sliders);
        const colors = new Adw.SwitchRow({title: _('Show light colors'), subtitle: _('White temperature and a color wheel when supported by the lamp.')});
        this._settings.bind('show-color-controls', colors, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(colors);
        const tileIcon = new Adw.ActionRow({title: _('Smart Home tile icon'), subtitle: _('Symbolic icons follow your GNOME theme.')});
        this._tileIconPreview = new Gtk.Image({gicon: resolveIcon(this._settings.get_string('tile-icon') || 'go-home-symbolic', 'home')});
        tileIcon.add_prefix(this._tileIconPreview);
        const chooseTileIcon = new Gtk.Button({label: _('Choose'), valign: Gtk.Align.CENTER});
        chooseTileIcon.connect('clicked', () => this._chooseIcon(choice => {
            this._settings.set_string('tile-icon', choice);
            this._tileIconPreview.gicon = resolveIcon(choice || 'go-home-symbolic', 'home');
        }));
        tileIcon.add_suffix(chooseTileIcon);
        tileIcon.activatable_widget = chooseTileIcon;
        appearance.add(tileIcon);
        const position = new Adw.SpinRow({
            title: _('Position in Quick Settings'),
            subtitle: _('0 keeps the default position; 1 places Smart Home first.'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 32, step_increment: 1, page_increment: 1}),
        });
        this._settings.bind('tile-position', position, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(position);
    }

    _buildDevices() {
        const _ = this._;
        this._devicesPage = new Adw.PreferencesPage({title: _('Devices'), icon_name: 'devices-symbolic'});
        this._window.add(this._devicesPage);
        this._favoritesGroup = new Adw.PreferencesGroup({title: _('In Quick Settings'), description: _('Expand a device to rename it. Use the arrows to change its position.')});
        this._devicesPage.add(this._favoritesGroup);
        this._emptyFavorite = new Adw.ActionRow({title: _('No devices selected'), subtitle: _('Choose devices from the list below.')});
        this._favoritesGroup.add(this._emptyFavorite);

        const filters = new Adw.PreferencesGroup({title: _('Find devices')});
        this._devicesPage.add(filters);
        this._search = new Gtk.SearchEntry({placeholder_text: _('Search name or entity ID'), hexpand: true, margin_top: 12, margin_bottom: 4});
        this._search.update_property([Gtk.AccessibleProperty.LABEL], [_('Search devices')]);
        filters.add(this._search);
        this._search.connect('search-changed', () => {
            if (this._searchTimer)
                GLib.Source.remove(this._searchTimer);
            this._searchTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this._searchTimer = 0;
                this._renderCatalog();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._domainChoices = [null, 'light', 'switch', 'fan', 'cover', 'climate', 'scene', 'script', 'sensor', 'binary_sensor', 'input_boolean', 'button', 'input_button'];
        this._domainFilter = new Adw.ComboRow({
            title: _('Device type'),
            model: Gtk.StringList.new([_('All types'), _('Lights'), _('Switches'), _('Fans'), _('Covers'), _('Climate'), _('Scenes'), _('Scripts'), _('Sensors'), _('Binary sensors'), _('Helpers'), _('Buttons'), _('Input buttons')]),
        });
        filters.add(this._domainFilter);
        this._domainFilter.connect('notify::selected', () => this._renderCatalog());
        this._catalog = new Adw.PreferencesGroup({title: _('Available devices')});
        this._devicesPage.add(this._catalog);
        this._catalogEmpty = new Adw.ActionRow({title: _('Connect to Home Assistant first'), subtitle: _('Open Connection and enter your server URL and token.')});
        this._catalog.add(this._catalogEmpty);
    }

    _iconButton(icon, tooltip, callback) {
        const button = new Gtk.Button({icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER, css_classes: ['flat']});
        button.connect('clicked', callback);
        return button;
    }

    _saveFavorites() {
        this._settings.set_string('devices', JSON.stringify(this._favorites));
        this._renderFavorites();
        this._syncChecks = true;
        for (const [id, check] of this._checks)
            check.active = this._favorites.some(favorite => favorite.id === id);
        this._syncChecks = false;
    }

    _renderFavorites() {
        const _ = this._;
        for (const row of this._favoriteRows)
            this._favoritesGroup.remove(row);
        this._favoriteRows = [];
        this._emptyFavorite.visible = this._favorites.length === 0;
        this._favorites.forEach((favorite, index) => {
            const entity = this._entities.find(item => item.entity_id === favorite.id);
            const row = new Adw.ExpanderRow({title: GLib.markup_escape_text(entityName(entity, favorite), -1), subtitle: favorite.id});
            row.add_prefix(new Gtk.Image({gicon: resolveIcon(favorite.icon, entity ?? favorite.id)}));
            const up = this._iconButton('go-up-symbolic', _('Move up'), () => this._move(index, -1));
            const down = this._iconButton('go-down-symbolic', _('Move down'), () => this._move(index, 1));
            up.sensitive = index > 0;
            down.sensitive = index < this._favorites.length - 1;
            row.add_suffix(up);
            row.add_suffix(down);
            row.add_suffix(this._iconButton('list-remove-symbolic', _('Remove device'), () => {
                this._favorites = this._favorites.filter(item => item.id !== favorite.id);
                this._saveFavorites();
            }));
            const name = new Adw.EntryRow({title: _('Custom name (empty uses Home Assistant name)'), text: favorite.name, show_apply_button: true});
            name.connect('apply', () => {
                favorite.name = name.text.trim();
                this._settings.set_string('devices', JSON.stringify(this._favorites));
                row.title = GLib.markup_escape_text(entityName(entity, favorite), -1);
            });
            row.add_row(name);
            const iconRow = new Adw.ActionRow({title: _('Icon'), subtitle: _('Symbolic icons follow your GNOME theme.')});
            const chooseIcon = new Gtk.Button({label: _('Choose'), valign: Gtk.Align.CENTER});
            chooseIcon.connect('clicked', () => this._chooseIcon(choice => {
                if (choice)
                    favorite.icon = choice;
                else
                    delete favorite.icon;
                this._saveFavorites();
            }));
            iconRow.add_suffix(chooseIcon);
            iconRow.activatable_widget = chooseIcon;
            row.add_row(iconRow);
            this._favoritesGroup.add(row);
            this._favoriteRows.push(row);
        });
    }

    _move(index, direction) {
        const target = index + direction;
        if (target < 0 || target >= this._favorites.length)
            return;
        [this._favorites[index], this._favorites[target]] = [this._favorites[target], this._favorites[index]];
        this._saveFavorites();
    }

    _renderCatalog() {
        const _ = this._;
        for (const row of this._catalogRows)
            this._catalog.remove(row);
        this._catalogRows = [];
        this._checks.clear();
        const query = (this._search.text ?? '').trim().toLocaleLowerCase();
        const domain = this._domainChoices[this._domainFilter.selected];
        const filtered = this._entities.filter(entity => SUPPORTED_DOMAINS.has(domainOf(entity.entity_id)) &&
            (!domain || domainOf(entity.entity_id) === domain) &&
            `${entityName(entity)} ${entity.entity_id}`.toLocaleLowerCase().includes(query));
        this._catalogEmpty.visible = filtered.length === 0;
        this._catalogEmpty.title = this._entities.length ? _('No matching devices') : _('Connect to Home Assistant first');
        this._catalogEmpty.subtitle = this._entities.length ? _('Try another name or device type.') : _('Open Connection and enter your server URL and token.');
        this._catalog.description = filtered.length > 100
            ? _('Showing the first 100 matches. Refine your search to find more.')
            : `${filtered.length} · ${_('devices')}`;
        for (const entity of filtered.slice(0, 100)) {
            const row = new Adw.ActionRow({title: entityName(entity), subtitle: entity.entity_id, use_markup: false});
            row.add_prefix(new Gtk.Image({gicon: resolveIcon('', entity)}));
            const check = new Gtk.CheckButton({active: this._favorites.some(item => item.id === entity.entity_id), valign: Gtk.Align.CENTER});
            check.update_property([Gtk.AccessibleProperty.LABEL], [entityName(entity)]);
            row.add_suffix(check);
            row.activatable_widget = check;
            check.connect('toggled', () => {
                if (this._syncChecks)
                    return;
                if (check.active && !this._favorites.some(item => item.id === entity.entity_id))
                    this._favorites.push({id: entity.entity_id, name: ''});
                else if (!check.active)
                    this._favorites = this._favorites.filter(item => item.id !== entity.entity_id);
                this._saveFavorites();
            });
            this._checks.set(entity.entity_id, check);
            this._catalog.add(row);
            this._catalogRows.push(row);
        }
    }

    _chooseIcon(onChoice) {
        const _ = this._;
        const dialog = new Adw.Dialog({title: _('Choose icon'), content_width: 440, content_height: 460});
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 12, margin_bottom: 20, margin_start: 20, margin_end: 20});
        toolbar.content = box;
        dialog.child = toolbar;
        const choose = icon => { onChoice(icon); dialog.close(); };
        const defaults = new Gtk.Button({label: _('Use device default')});
        defaults.connect('clicked', () => choose(''));
        box.append(defaults);
        const grid = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE,
            min_children_per_line: 6, max_children_per_line: 6, row_spacing: 6, column_spacing: 6, homogeneous: true});
        for (const [icon, label] of ICON_CHOICES) {
            const button = new Gtk.Button({child: new Gtk.Image({gicon: resolveIcon(icon, 'home'), pixel_size: 24}),
                tooltip_text: _(label), css_classes: ['flat'], width_request: 46, height_request: 46});
            button.connect('clicked', () => choose(icon));
            grid.append(button);
        }
        box.append(grid);
        const group = new Adw.PreferencesGroup();
        const themeIcon = new Adw.EntryRow({title: _('Symbolic icon name'), show_apply_button: true});
        themeIcon.connect('apply', () => {
            const value = themeIcon.text.trim();
            if (value.endsWith('-symbolic') && Gtk.IconTheme.get_for_display(this._window.get_display()).has_icon(value))
                choose(value);
            else
                this._window.add_toast(new Adw.Toast({title: _('This symbolic icon is not in your icon theme.')}));
        });
        group.add(themeIcon);
        box.append(group);
        const custom = new Gtk.Button({label: _('Choose monochrome SVG…')});
        custom.connect('clicked', () => {
            const filter = new Gtk.FileFilter();
            filter.set_name(_('SVG icons'));
            filter.add_mime_type('image/svg+xml');
            const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
            filters.append(filter);
            const chooser = new Gtk.FileDialog({title: _('Choose symbolic SVG icon'), filters});
            chooser.open(this._window, this._cancel, async (source, result) => {
                let file;
                try {
                    file = source.open_finish(result);
                } catch {
                    return;
                }
                try {
                    const uri = await importSymbolicIcon(file, this._cancel);
                    if (!this._closed)
                        choose(uri);
                } catch {
                    if (!this._closed)
                        this._window.add_toast(new Adw.Toast({title: _('Choose a simple monochrome SVG without images or gradients.')}));
                }
            });
        });
        box.append(custom);
        dialog.present(this._window);
        return dialog;
    }

    async _loadSaved() {
        if (this._settings.get_string('server-url'))
            await this._connect(false);
    }

    _setBusy(busy) {
        this._busy = busy;
        this._spinner.spinning = busy;
        this._connectButton.sensitive = !busy;
        this._forgetButton.sensitive = !busy;
        this._url.sensitive = !busy;
        this._token.sensitive = !busy;
    }

    async _connect(save) {
        if (this._busy || this._closed)
            return;
        const _ = this._;
        this._setBusy(true);
        this._status.title = _('Connecting…');
        this._status.subtitle = '';
        let stage = 'url';
        try {
            const url = validateUrl(this._url.text);
            stage = 'keyring';
            const enteredToken = this._token.text.trim();
            const token = enteredToken || await lookupToken(url, this._cancel);
            if (!token)
                throw new Error('missing-token');
            stage = 'network';
            const entities = await discoverEntities(url, token, this._cancel);
            if (this._closed)
                return;
            if (save) {
                stage = 'keyring';
                if (enteredToken)
                    await storeToken(url, token, this._cancel);
                if (this._closed)
                    return;
                // Each server has its own keyring entry. Favorites belong to one server.
                if (this._settings.get_string('server-url') && this._settings.get_string('server-url') !== url) {
                    this._favorites = [];
                    this._settings.set_string('devices', '[]');
                }
                this._settings.set_string('server-url', url);
                this._bumpCredentials();
            }
            this._token.text = '';
            this._url.text = url;
            this._entities = entities.sort((a, b) => entityName(a).localeCompare(entityName(b)));
            this._status.title = _('Connected');
            this._status.subtitle = `${entities.length} · ${_('entities available')}`;
            this._forgetRow.visible = true;
            this._renderFavorites();
            this._renderCatalog();
            if (save) {
                this._window.add_toast(new Adw.Toast({title: _('Connected. Choose your devices.')}));
                this._window.set_visible_page(this._devicesPage);
            }
        } catch (error) {
            if (this._closed)
                return;
            this._status.title = _('Connection failed');
            this._status.subtitle = error.message === 'missing-token' ? _('Enter an access token for this server.')
                : stage === 'url' ? _('Enter a valid http:// or https:// server URL without credentials, query, or fragment.')
                    : stage === 'keyring' ? _('Could not access the GNOME keyring. Unlock your login keyring and try again.')
                        : error.code === 'auth' ? _('Home Assistant rejected this token. Create a new long-lived access token.')
                            : error.code === 'permission' ? _('This user does not have permission to read entities.')
                                : _('Check the server address, network, and TLS certificate, then try again.');
        } finally {
            if (!this._closed)
                this._setBusy(false);
        }
    }

    _bumpCredentials() {
        this._settings.set_uint('credential-revision', (this._settings.get_uint('credential-revision') + 1) % 0xffffffff);
    }

    async _forget() {
        if (this._busy || this._closed)
            return;
        this._setBusy(true);
        try {
            const url = this._settings.get_string('server-url');
            if (url)
                await clearToken(url, this._cancel);
            if (this._closed)
                return;
            this._settings.set_string('server-url', '');
            this._bumpCredentials();
            this._url.text = '';
            this._token.text = '';
            this._entities = [];
            this._favorites = [];
            this._settings.set_string('devices', '[]');
            this._status.title = this._('Not connected');
            this._status.subtitle = '';
            this._forgetRow.visible = false;
            this._renderFavorites();
            this._renderCatalog();
        } catch {
            if (!this._closed)
                this._window.add_toast(new Adw.Toast({title: this._('Could not remove the saved token.')}));
        } finally {
            if (!this._closed)
                this._setBusy(false);
        }
    }
}
