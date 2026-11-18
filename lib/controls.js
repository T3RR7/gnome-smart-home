// SPDX-License-Identifier: MIT
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    colorCommand, colorTemperatureCommand, commandConfirmed, domainOf, entityName,
    hexToRgb, iconFor, isAvailable, isOn, lightCapabilities, previewCommand, rgbToHex,
    sliderCommand, sliderFor, temperatureCommand, toggleCommand,
} from './model.js';

// Device switches should keep the menu open, including when activated by keyboard.
const DeviceSwitch = GObject.registerClass(
class GshDeviceSwitch extends PopupMenu.PopupSwitchMenuItem {
    activate() {
        if (this.reactive)
            this.toggle();
    }
});

export class ScrollableSection extends PopupMenu.PopupMenuSection {
    constructor() {
        super();
        this.actor = new St.ScrollView({
            style_class: 'gsh-device-list',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this.box,
            x_expand: true,
        });
        this.actor._delegate = this;
    }
}

/**
 * Owns the Shell widgets and pending command state for one favorite entity.
 * The extension supplies fresh server state through update().
 */
export class DeviceControl {
    constructor(favorite, {icons, showSliders, showColors = true, runCommand, pickColor = async () => null}) {
        this.favorite = favorite;
        this._icons = icons;
        this._runCommand = runCommand;
        this._pickColor = pickColor;
        this._domain = domainOf(favorite.id);
        this._syncing = false;
        this._pending = false;
        this._request = null;
        this._confirmationTimer = 0;
        this._destroyed = false;
        this._debounce = 0;
        this._dragging = false;
        this.section = new PopupMenu.PopupMenuSection();

        if (['light', 'switch', 'input_boolean', 'fan'].includes(this._domain)) {
            this._toggle = new DeviceSwitch(favorite.id, false);
            this._deviceIcon = new St.Icon({icon_name: 'go-home-symbolic', style_class: 'popup-menu-icon'});
            this._toggle.insert_child_at_index(this._deviceIcon, 1);
            this._toggle.label.x_expand = true;
            this._toggle.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._toggle.connect('toggled', (_row, state) => {
                if (!this._syncing)
                    this._execute(toggleCommand(favorite.id, state));
            });
            this.section.addMenuItem(this._toggle);
        } else if (['scene', 'script', 'button', 'input_button'].includes(this._domain)) {
            this._action = new PopupMenu.PopupImageMenuItem(favorite.id, 'go-home-symbolic');
            this._loadIcon(favorite.icon, icon => this._action.setIcon(icon));
            this._action.label.x_expand = true;
            this._action.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._action.connect('activate', () => this._execute({
                domain: this._domain,
                service: ['button', 'input_button'].includes(this._domain) ? 'press' : 'turn_on',
                target: {entity_id: favorite.id},
            }));
            this.section.addMenuItem(this._action);
        } else {
            this._heading = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            this._deviceIcon = new St.Icon({icon_name: 'go-home-symbolic', style_class: 'popup-menu-icon'});
            this._heading.add_child(this._deviceIcon);
            this._name = new St.Label({text: favorite.id, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._value = new St.Label({style_class: 'gsh-state', y_align: Clutter.ActorAlign.CENTER});
            this._heading.add_child(this._name);
            this._heading.add_child(this._value);
            this.section.addMenuItem(this._heading);
        }

        if (showSliders && ['light', 'fan', 'cover'].includes(this._domain))
            this._buildSlider();
        if (showColors && this._domain === 'light')
            this._buildLightColors();
        if (this._domain === 'cover')
            this._buildCover();
        if (this._domain === 'climate')
            this._buildClimate();
    }

    // Apply asynchronously loaded icons in place so focus and gestures survive.
    async _loadIcon(choice, apply) {
        const icon = await this._icons.resolve(choice, this.favorite.id);
        if (icon && !this._destroyed)
            apply(icon);
    }

    _createIcon(name) {
        const actor = new St.Icon({icon_name: name, style_class: 'popup-menu-icon'});
        this._loadIcon(name, icon => { actor.gicon = icon; });
        return actor;
    }

    _buildSlider() {
        this._sliderRow = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        this._sliderRow.add_style_class_name('gsh-slider-row');
        this._sliderRow.add_child(this._createIcon(this._domain === 'light'
            ? 'display-brightness-symbolic' : iconFor(this.favorite.id)));
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._sliderRow.add_child(this._slider);
        this._percent = new St.Label({style_class: 'gsh-percent', y_align: Clutter.ActorAlign.CENTER});
        this._sliderRow.add_child(this._percent);
        this._slider.connect('drag-begin', () => { this._dragging = true; });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            this._flushSlider();
        });
        this._slider.connect('notify::value', () => {
            if (this._syncing)
                return;
            this._percent.text = `${Math.round(this._slider.value * 100)}%`;
            if (this._debounce)
                GLib.Source.remove(this._debounce);
            // While dragging, send only the final position; keyboard/scroll are debounced.
            this._debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._debounce = 0;
                if (!this._dragging)
                    this._flushSlider();
                return GLib.SOURCE_REMOVE;
            });
        });
        this.section.addMenuItem(this._sliderRow);
    }

    _buildLightColors() {
        this._temperatureRow = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        this._temperatureRow.add_style_class_name('gsh-slider-row');
        this._temperatureRow.add_child(this._createIcon('night-light-symbolic'));
        this._temperatureSlider = new Slider(0.5);
        this._temperatureSlider.x_expand = true;
        this._temperatureRow.add_child(this._temperatureSlider);
        this._kelvin = new St.Label({style_class: 'gsh-kelvin', y_align: Clutter.ActorAlign.CENTER});
        this._temperatureRow.add_child(this._kelvin);
        this._temperatureSlider.connect('drag-begin', () => { this._temperatureDragging = true; });
        this._temperatureSlider.connect('drag-end', () => {
            this._temperatureDragging = false;
            this._flushTemperature();
        });
        this._temperatureSlider.connect('notify::value', () => {
            if (this._syncing)
                return;
            const descriptor = lightCapabilities(this._entity).temperature;
            if (!descriptor)
                return;
            this._kelvin.text = `${Math.round(descriptor.min + this._temperatureSlider.value * (descriptor.max - descriptor.min))} K`;
            if (this._temperatureDebounce)
                GLib.Source.remove(this._temperatureDebounce);
            this._temperatureDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._temperatureDebounce = 0;
                if (!this._temperatureDragging)
                    this._flushTemperature();
                return GLib.SOURCE_REMOVE;
            });
        });
        this.section.addMenuItem(this._temperatureRow);

        this._paletteRow = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        this._paletteRow.add_style_class_name('gsh-palette-row');
        this._swatches = [
            ['#ffffff', _('White')], ['#ff3b30', _('Red')], ['#ff9500', _('Orange')],
            ['#ffcc00', _('Yellow')], ['#34c759', _('Green')], ['#00c7be', _('Turquoise')],
            ['#007aff', _('Blue')], ['#af52de', _('Purple')], ['#ff2d55', _('Pink')],
        ].map(([hex, label]) => {
            const rgb = hexToRgb(hex);
            const button = new St.Button({
                style_class: 'button gsh-color-swatch',
                child: new St.Widget({style_class: 'gsh-color-dot', style: `background-color: ${hex};`}),
                can_focus: true,
                accessible_name: label,
            });
            button.connect('clicked', () => this._execute(colorCommand(this._entity, rgb)));
            this._paletteRow.add_child(button);
            return {button, hex};
        });
        this._colorPickerButton = this._button('color-select-symbolic', _('Choose any color'), () => this._chooseColor());
        this._colorPickerButton.x_expand = false;
        this._colorPickerButton.style_class = 'button gsh-color-picker-button';
        this._paletteRow.add_child(this._colorPickerButton);
        this.section.addMenuItem(this._paletteRow);
    }

    async _chooseColor() {
        if (!this._connected || !isAvailable(this._entity) || !lightCapabilities(this._entity).color)
            return;
        const initial = this._entity.attributes?.rgb_color ?? [255, 255, 255];
        const rgb = await this._pickColor(initial);
        if (rgb && !this._destroyed && this._connected && lightCapabilities(this._entity).color)
            await this._execute(colorCommand(this._entity, rgb));
    }

    _flushTemperature() {
        if (this._temperatureDebounce) {
            GLib.Source.remove(this._temperatureDebounce);
            this._temperatureDebounce = 0;
        }
        const descriptor = lightCapabilities(this._entity).temperature;
        if (descriptor && this._connected && isAvailable(this._entity)) {
            const kelvin = descriptor.min + this._temperatureSlider.value * (descriptor.max - descriptor.min);
            this._execute(colorTemperatureCommand(this._entity, kelvin));
        }
    }

    _flushSlider() {
        if (this._debounce) {
            GLib.Source.remove(this._debounce);
            this._debounce = 0;
        }
        const descriptor = sliderFor(this._entity);
        if (descriptor && this._connected && isAvailable(this._entity))
            this._execute(sliderCommand(this.favorite.id, descriptor.kind, this._slider.value));
    }

    _button(iconName, label, callback) {
        const button = new St.Button({
            style_class: 'button gsh-control-button',
            child: this._createIcon(iconName),
            accessible_name: label,
            can_focus: true,
            x_expand: true,
        });
        button.connect('clicked', callback);
        return button;
    }

    _buildCover() {
        this._buttonsRow = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        this._buttonsRow.add_style_class_name('gsh-buttons-row');
        this._coverButtons = [
            [1, 'pan-up-symbolic', _('Open'), 'open_cover'],
            [8, 'media-playback-stop-symbolic', _('Stop'), 'stop_cover'],
            [2, 'pan-down-symbolic', _('Close'), 'close_cover'],
        ].map(([feature, icon, label, service]) => {
            const button = this._button(icon, label, () => this._execute({
                domain: 'cover', service, target: {entity_id: this.favorite.id},
            }));
            this._buttonsRow.add_child(button);
            return {feature, button};
        });
        this.section.addMenuItem(this._buttonsRow);
    }

    _buildClimate() {
        this._buttonsRow = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        this._buttonsRow.add_style_class_name('gsh-buttons-row');
        this._minus = this._button('list-remove-symbolic', _('Decrease temperature'),
            () => this._execute(temperatureCommand(this._entity, -1)));
        this._target = new St.Label({
            style_class: 'gsh-temperature', x_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        this._plus = this._button('list-add-symbolic', _('Increase temperature'),
            () => this._execute(temperatureCommand(this._entity, 1)));
        this._buttonsRow.add_child(this._minus);
        this._buttonsRow.add_child(this._target);
        this._buttonsRow.add_child(this._plus);
        this.section.addMenuItem(this._buttonsRow);
    }

    update(entity, connected) {
        this._entity = entity;
        this._connected = connected;
        const available = connected && isAvailable(entity);
        if (!available || (this._request && commandConfirmed(entity, this._request.command)))
            this._clearRequest();
        const view = previewCommand(entity, this._request?.command);
        // Keep keyboard focus and pointer gestures stable while the request runs.
        // If the person changes a control again, send the latest choice next.
        const enabled = available;
        const name = entityName(entity, this.favorite);
        this._syncing = true;
        if (this._deviceIcon) {
            const choice = this.favorite.icon || iconFor(entity ?? this.favorite.id);
            if (choice !== this._deviceIconChoice) {
                this._deviceIconChoice = choice;
                this._loadIcon(choice, icon => {
                    if (choice === this._deviceIconChoice)
                        this._deviceIcon.gicon = icon;
                });
            }
        }
        if (this._toggle) {
            this._toggle.label.text = name;
            this._toggle.setToggleState(isOn(view));
            // Never replace the switch with a label while a command is pending:
            // doing so changes row geometry and interrupts the native gesture.
            const status = available ? null : _('Unavailable');
            if (status !== this._toggleStatus) {
                this._toggle.setStatus(status);
                this._toggleStatus = status;
            }
            if (this._toggle.sensitive !== enabled)
                this._toggle.setSensitive(enabled);
        }
        if (this._action) {
            this._action.label.text = name;
            if (this._action.sensitive !== enabled)
                this._action.setSensitive(enabled);
        }
        if (this._name) {
            this._name.text = name;
            this._value.text = available ? this._stateText(entity) : _('Unavailable');
        }
        const descriptor = sliderFor(view);
        if (this._sliderRow) {
            this._sliderRow.visible = Boolean(descriptor);
            if (this._sliderRow.sensitive !== enabled)
                this._sliderRow.setSensitive(enabled);
            this._slider.reactive = enabled;
            this._slider.can_focus = enabled;
            this._slider.accessible_name = `${name} — ${
                this._domain === 'light' ? _('Brightness') : this._domain === 'fan' ? _('Speed') : _('Position')}`;
            if (descriptor && !this._dragging && !this._debounce) {
                this._slider.value = Math.min(1, Math.max(0, descriptor.value));
                this._percent.text = `${Math.round(this._slider.value * 100)}%`;
            }
        }
        if (this._temperatureRow) {
            const capabilities = lightCapabilities(view);
            const temperature = capabilities.temperature;
            this._temperatureRow.visible = Boolean(temperature);
            if (this._temperatureRow.sensitive !== enabled)
                this._temperatureRow.setSensitive(enabled);
            this._temperatureSlider.reactive = enabled;
            this._temperatureSlider.can_focus = enabled;
            this._temperatureSlider.accessible_name = `${name} — ${_('Color temperature')}`;
            if (temperature && !this._temperatureDragging && !this._temperatureDebounce) {
                this._temperatureSlider.value = (temperature.kelvin - temperature.min) / (temperature.max - temperature.min);
                this._kelvin.text = view?.attributes?.color_mode && view.attributes.color_mode !== 'color_temp'
                    ? '— K' : `${Math.round(temperature.kelvin)} K`;
            }
            this._paletteRow.visible = capabilities.color;
            const hex = rgbToHex(view?.attributes?.rgb_color);
            const colorMode = view?.attributes?.color_mode;
            const usingColor = !colorMode || ['rgb', 'rgbw', 'rgbww', 'hs', 'xy'].includes(colorMode);
            for (const {button, hex: swatchHex} of this._swatches) {
                button.reactive = enabled;
                button.can_focus = enabled;
                button.checked = usingColor && hex === swatchHex;
            }
            this._colorPickerButton.reactive = enabled;
            this._colorPickerButton.can_focus = enabled;
            this._colorPickerButton.checked = usingColor && Boolean(hex) && !this._swatches.some(swatch => swatch.hex === hex);
        }
        if (this._coverButtons) {
            const features = Number(entity?.attributes?.supported_features) || 0;
            for (const {feature, button} of this._coverButtons) {
                button.visible = Boolean(features & feature);
                button.reactive = enabled;
                button.can_focus = enabled;
                button.accessible_name = `${name} — ${feature === 1 ? _('Open') : feature === 2 ? _('Close') : _('Stop')}`;
            }
            this._buttonsRow.visible = this._coverButtons.some(({button}) => button.visible);
        }
        if (this._target) {
            const a = view?.attributes ?? {};
            this._buttonsRow.visible = Number.isFinite(a.temperature) && Boolean(Number(a.supported_features) & 1);
            this._target.text = `${a.temperature ?? '—'} ${a.temperature_unit ?? '°'}`;
            this._minus.reactive = enabled && a.temperature > (a.min_temp ?? -100);
            this._plus.reactive = enabled && a.temperature < (a.max_temp ?? 100);
            this._minus.can_focus = this._minus.reactive;
            this._plus.can_focus = this._plus.reactive;
        }
        this._syncing = false;
    }

    _stateText(entity) {
        const a = entity.attributes ?? {};
        if (this._domain === 'climate' && Number.isFinite(a.current_temperature))
            return `${a.current_temperature} ${a.temperature_unit ?? '°'} · ${entity.state}`;
        if (this._domain === 'binary_sensor')
            return entity.state === 'on' ? _('Active') : _('Inactive');
        if (this._domain === 'cover') {
            const state = {open: _('Open'), closed: _('Closed'), opening: _('Opening'), closing: _('Closing')}[entity.state];
            return state ?? entity.state;
        }
        return `${entity.state}${a.unit_of_measurement ? ` ${a.unit_of_measurement}` : ''}`;
    }

    async _execute(command) {
        if (this._destroyed || !this._connected || !isAvailable(this._entity))
            return;
        if (this._pending) {
            // Coalesce edits while a request is in flight so rapid slider
            // movements do not build up a backlog of stale values.
            this._queuedCommand = command;
            this._clearRequest();
            this._request = {command};
            this.update(this._entity, this._connected);
            return;
        }
        this._pending = true;
        this._clearRequest();
        const request = {command};
        this._request = request;
        this.update(this._entity, this._connected);
        try {
            await this._runCommand(command);
        } catch {
            // Restore the server state after the extension reports the error.
            if (this._request === request)
                this._clearRequest();
        } finally {
            this._pending = false;
            if (!this._destroyed) {
                const queued = this._queuedCommand;
                this._queuedCommand = null;
                if (queued) {
                    this._execute(queued);
                    return;
                }
                if (this._request === request) {
                    // Service success can arrive before the device reports its
                    // new state. Clear the preview if that event never arrives.
                    this._confirmationTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                        this._confirmationTimer = 0;
                        this._request = null;
                        this.update(this._entity, this._connected);
                        return GLib.SOURCE_REMOVE;
                    });
                }
                this.update(this._entity, this._connected);
            }
        }
    }

    _clearRequest() {
        this._request = null;
        if (this._confirmationTimer)
            GLib.Source.remove(this._confirmationTimer);
        this._confirmationTimer = 0;
    }

    destroy() {
        this._destroyed = true;
        this._queuedCommand = null;
        this._clearRequest();
        if (this._debounce)
            GLib.Source.remove(this._debounce);
        this._debounce = 0;
        if (this._temperatureDebounce)
            GLib.Source.remove(this._temperatureDebounce);
        this._temperatureDebounce = 0;
        this.section.destroy();
    }
}
