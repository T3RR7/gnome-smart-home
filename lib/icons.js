// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {iconFor} from './model.js';

const [modulePath] = GLib.filename_from_uri(import.meta.url);
export const ICON_DIRECTORY = `${GLib.path_get_dirname(GLib.path_get_dirname(modulePath))}/icons/gnome`;
const IMPORTED_ICON_DIRECTORY = `${GLib.get_user_data_dir()}/gnome-smart-home/icons`;

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
    return themedIcon(name);
}

function themedIcon(name) {
    if (name.endsWith('-symbolic'))
        return new Gio.ThemedIcon({names: [name, 'go-home-symbolic']});
    return new Gio.ThemedIcon({name: 'go-home-symbolic'});
}

function* stockIconPaths(name) {
    yield `${ICON_DIRECTORY}/${name}.svg`;
    for (const directory of GLib.get_system_data_dirs()) {
        for (const category of ['status', 'actions', 'devices', 'places', 'apps', 'legacy', 'categories', 'ui', 'mimetypes', 'emotes'])
            yield `${directory}/icons/Adwaita/symbolic/${category}/${name}.svg`;
    }
}

async function hasFile(file, cancellable) {
    try {
        await file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        return true;
    } catch {
        cancellable.set_error_if_cancelled();
        return false;
    }
}

async function makeCacheDirectory(directory, cancellable) {
    try {
        await directory.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
        await makeCacheDirectory(directory.get_parent(), cancellable);
        await makeCacheDirectory(directory, cancellable);
    }
}

/** Resolves Shell icons asynchronously and shares pending work across an enable cycle. */
export class ShellIcons {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._icons = new Map();
        this._cache = Gio.File.new_for_path(`${GLib.get_user_cache_dir()}/gnome-smart-home/icons`);
    }

    async resolve(choice, entityId) {
        const fallback = iconFor(entityId);
        const name = choice || fallback;
        if (!this._icons.has(name))
            this._icons.set(name, this._load(name));
        const icon = await this._icons.get(name);
        if (icon || name === fallback || this._cancellable.is_cancelled())
            return icon;
        return this.resolve('', entityId);
    }

    async _load(name) {
        const custom = name.startsWith('file:///');
        try {
            const paths = custom ? [Gio.File.new_for_uri(name).get_path()] : stockIconPaths(name);
            for (const path of paths) {
                const file = Gio.File.new_for_path(path);
                if (await hasFile(file, this._cancellable)) {
                    return await this._symbolicIcon(file, path).catch(() => {
                        this._cancellable.set_error_if_cancelled();
                        // Keep the source icon available if its cache cannot be written.
                        return new Gio.FileIcon({file});
                    });
                }
            }
        } catch {
            if (this._cancellable.is_cancelled())
                return null;
        }
        return custom ? null : themedIcon(name);
    }

    async _symbolicIcon(source, path) {
        if (!path.startsWith(`${ICON_DIRECTORY}/`) && !path.startsWith(`${IMPORTED_ICON_DIRECTORY}/`))
            return new Gio.FileIcon({file: source});

        const [bytes] = await source.load_contents_async(this._cancellable);
        // Shell recolors SVG fills. Put the original silhouette in a separate
        // image document and let Shell recolor the rectangle behind its alpha mask.
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="16" height="16">
  <mask id="shape" mask-type="alpha">
    <image width="16" height="16" xlink:href="data:image/svg+xml;base64,${GLib.base64_encode(bytes)}"/>
  </mask>
  <rect width="16" height="16" mask="url(#shape)"/>
</svg>`;
        const checksum = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, svg, -1);
        const target = this._cache.get_child(`${checksum}-${source.get_basename()}`);
        if (!await hasFile(target, this._cancellable)) {
            this._cacheReady ??= makeCacheDirectory(this._cache, this._cancellable);
            await this._cacheReady;
            await target.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(svg)), null, false,
                Gio.FileCreateFlags.PRIVATE, this._cancellable);
        }
        return new Gio.FileIcon({file: target});
    }

    destroy() {
        this._cancellable.cancel();
        this._icons.clear();
    }
}

const stockFiles = new Map();
export function stockIconFile(name) {
    if (stockFiles.has(name))
        return stockFiles.get(name);
    for (const path of stockIconPaths(name)) {
        const file = Gio.File.new_for_path(path);
        if (file.query_exists(null)) {
            stockFiles.set(name, file);
            return file;
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
    GLib.mkdir_with_parents(IMPORTED_ICON_DIRECTORY, 0o700);
    const target = Gio.File.new_for_path(`${IMPORTED_ICON_DIRECTORY}/${GLib.uuid_string_random()}-symbolic.svg`);
    await target.replace_contents_bytes_async(new GLib.Bytes(bytes), null, false,
        Gio.FileCreateFlags.PRIVATE, cancellable);
    return target.get_uri();
}

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async', 'make_directory_finish');
