// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {iconFor} from './model.js';

export const ICON_DIRECTORY = `${Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path()}/icons/gnome`;

export const ICON_CHOICES = [
    ['lightbulb-modern-symbolic', 'Light bulb'], ['lamp-symbolic', 'Desk lamp'],
    ['switch-left-symbolic', 'Switch'], ['plug-symbolic', 'Socket'],
    ['chip-symbolic', 'Sensor'], ['devices-symbolic', 'Devices'],
    ['ac-symbolic', 'Wall power'],
    ['display-brightness-symbolic', 'Brightness'], ['night-light-symbolic', 'Night light'],
    ['weather-clear-symbolic', 'Daylight'], ['weather-clear-night-symbolic', 'Moonlight'],
    ['system-shutdown-symbolic', 'Power'],
    ['weather-windy-symbolic', 'Fan'], ['view-list-symbolic', 'Blinds'],
    ['go-home-symbolic', 'Home'], ['starred-symbolic', 'Scene'],
    ['color-select-symbolic', 'Color'],
    ['system-run-symbolic', 'Script'], ['media-playback-start-symbolic', 'Button'],
];

export function resolveIcon(choice, entityId) {
    const name = choice || iconFor(entityId);
    if (name.startsWith('file:///')) {
        const file = Gio.File.new_for_uri(name);
        if (file.query_exists(null))
            return new Gio.FileIcon({file});
        return resolveIcon('', entityId);
    }
    // Some stock Adwaita symbols are not indexed by a theme's GTK icon cache.
    // Read the original GNOME asset directly; no redrawing or replacement art.
    const stock = stockIconFile(name);
    if (stock)
        return new Gio.FileIcon({file: stock});
    if (name.endsWith('-symbolic'))
        return new Gio.ThemedIcon({names: [name, 'go-home-symbolic']});
    return new Gio.ThemedIcon({name: 'go-home-symbolic'});
}

const stockFiles = new Map();
export function stockIconFile(name) {
    if (stockFiles.has(name))
        return stockFiles.get(name);
    const bundled = Gio.File.new_for_path(`${ICON_DIRECTORY}/${name}.svg`);
    if (bundled.query_exists(null)) {
        stockFiles.set(name, bundled);
        return bundled;
    }
    for (const directory of GLib.get_system_data_dirs()) {
        for (const category of ['status', 'actions', 'devices', 'places', 'apps', 'legacy', 'categories', 'ui', 'mimetypes', 'emotes']) {
            const file = Gio.File.new_for_path(`${directory}/icons/Adwaita/symbolic/${category}/${name}.svg`);
            if (file.query_exists(null)) {
                stockFiles.set(name, file);
                return file;
            }
        }
    }
    stockFiles.set(name, null);
    return null;
}

export async function importSymbolicIcon(file, cancellable) {
    const [bytes] = await file.load_contents_async(cancellable);
    if (bytes.length > 256 * 1024)
        throw new Error('invalid-icon');
    const svg = new TextDecoder().decode(bytes);
    // Symbolic vectors only. Reject images, active content and external resources.
    if (!/<svg\b/i.test(svg) || /<(?:image|script|foreignObject|linearGradient|radialGradient)\b|(?:href\s*=|url\s*\()/i.test(svg))
        throw new Error('invalid-icon');
    const colors = [...svg.matchAll(/(?:fill|stroke)\s*=\s*["']([^"']+)["']/gi)]
        .map(match => match[1].toLowerCase()).filter(value => !['none', 'currentcolor', 'inherit'].includes(value));
    if (new Set(colors).size > 1)
        throw new Error('invalid-icon');
    const directory = `${GLib.get_user_data_dir()}/gnome-smart-home/icons`;
    GLib.mkdir_with_parents(directory, 0o700);
    const target = Gio.File.new_for_path(`${directory}/${GLib.uuid_string_random()}-symbolic.svg`);
    await target.replace_contents_bytes_async(new GLib.Bytes(bytes), null, false,
        Gio.FileCreateFlags.PRIVATE, cancellable);
    return target.get_uri();
}

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
