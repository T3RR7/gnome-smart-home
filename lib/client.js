// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {applyEntityDiff, normalizeUrl, websocketUrl} from './model.js';

export class HomeAssistantError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

export function validateUrl(input) {
    const url = normalizeUrl(input);
    const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    if (!uri.get_host() || uri.get_userinfo() || uri.get_port() > 65535)
        throw new HomeAssistantError('invalid-url');
    return url;
}

// A short-lived REST session is used only for device discovery in preferences.
export async function discoverEntities(url, token, cancellable) {
    const session = new Soup.Session({timeout: 15, user_agent: 'GnomeSmartHome/0.3'});
    try {
        const message = Soup.Message.new('GET', `${validateUrl(url)}/api/states`);
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        const bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                try {
                    resolve(source.send_and_read_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        });
        if (message.status_code === 401)
            throw new HomeAssistantError('auth');
        if (message.status_code === 403)
            throw new HomeAssistantError('permission');
        if (message.status_code !== 200)
            throw new HomeAssistantError('http');
        const states = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        if (!Array.isArray(states) || states.some(state => typeof state.entity_id !== 'string'))
            throw new HomeAssistantError('protocol');
        return states;
    } finally {
        session.abort();
    }
}

export class HomeAssistantClient {
    constructor({url, token, entityIds = [], onStatus = () => {}, onStates = () => {}}) {
        this.url = validateUrl(url);
        this._token = token;
        this._entityIds = entityIds;
        this._onStatus = onStatus;
        this._onStates = onStates;
        this.states = new Map();
        this._running = false;
        this._authenticated = false;
        this._ready = false;
        this._serial = 0;
        this._nextId = 1;
        this._retryDelay = 1;
        this._pending = new Map();
        this._sources = new Set();
        this._socketSignals = [];
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        this._connect();
    }

    stop() {
        this._running = false;
        this._disconnect();
        this._token = null;
        this._onStatus = () => {};
        this._onStates = () => {};
    }

    async _connect() {
        const serial = ++this._serial;
        this._onStatus('connecting');
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const session = new Soup.Session({timeout: 15, user_agent: 'GnomeSmartHome/0.3'});
        this._session = session;
        try {
            const message = Soup.Message.new('GET', websocketUrl(this.url));
            // A token is sent only after a successful handshake with this exact URL.
            message.set_flags(Soup.MessageFlags.NO_REDIRECT);
            const socket = await new Promise((resolve, reject) => {
                session.websocket_connect_async(message, null, null, GLib.PRIORITY_DEFAULT,
                    cancellable, (source, result) => {
                        try {
                            resolve(source.websocket_connect_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    });
            });
            if (serial !== this._serial || !this._running) {
                socket.close(Soup.WebsocketCloseCode.NORMAL, null);
                return;
            }
            this._socket = socket;
            socket.max_incoming_payload_size = 16 * 1024 * 1024;
            this._socketSignals = [
                socket.connect('message', (_socket, type, bytes) => {
                    if (serial !== this._serial || type !== Soup.WebsocketDataType.TEXT)
                        return;
                    try {
                        this._receive(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                    } catch {
                        this._fail('protocol');
                    }
                }),
                socket.connect('closed', () => this._fail('network')),
                socket.connect('error', () => this._fail('network')),
            ];
            this._handshakeTimer = this._after(15000, () => this._fail('timeout'));
        } catch (error) {
            if (serial === this._serial && this._running)
                this._fail(error.code === 'auth' ? 'auth' : 'network');
        }
    }

    _receive(message) {
        if (message.type === 'auth_required' && !this._authenticated) {
            this._send({type: 'auth', access_token: this._token});
        } else if (message.type === 'auth_invalid') {
            this._fail('auth', true);
        } else if (message.type === 'auth_ok' && !this._authenticated) {
            this._authenticated = true;
            this.states.clear();
            this._subscriptionId = this._nextId++;
            const subscription = {id: this._subscriptionId, type: 'subscribe_entities'};
            if (this._entityIds.length)
                subscription.entity_ids = this._entityIds;
            this._send(subscription);
        } else if (message.type === 'event' && message.id === this._subscriptionId) {
            applyEntityDiff(this.states, message.event);
            if (!this._ready) {
                this._ready = true;
                this._retryDelay = 1;
                this._removeSource(this._handshakeTimer);
                this._handshakeTimer = 0;
                this._onStatus('connected');
                this._schedulePing();
            }
            this._onStates(this.states);
        } else if (message.type === 'result' || message.type === 'pong') {
            if (message.id === this._subscriptionId) {
                if (!message.success)
                    this._fail('permission', true);
                return;
            }
            const request = this._pending.get(message.id);
            if (!request)
                return;
            this._pending.delete(message.id);
            this._removeSource(request.timer);
            if (message.type === 'pong' || message.success)
                request.resolve(message.result);
            else
                request.reject(new HomeAssistantError('service'));
        }
    }

    callService(command) {
        if (!this._ready)
            return Promise.reject(new HomeAssistantError('offline'));
        return this._request({type: 'call_service', ...command});
    }

    _request(command) {
        return new Promise((resolve, reject) => {
            const id = this._nextId++;
            const timer = this._after(12000, () => {
                this._pending.delete(id);
                reject(new HomeAssistantError('timeout'));
            });
            this._pending.set(id, {resolve, reject, timer});
            try {
                this._send({id, ...command});
            } catch {
                this._pending.delete(id);
                this._removeSource(timer);
                reject(new HomeAssistantError('network'));
            }
        });
    }

    _send(message) {
        if (this._socket?.state !== Soup.WebsocketState.OPEN)
            throw new HomeAssistantError('offline');
        this._socket.send_text(JSON.stringify(message));
    }

    _schedulePing() {
        const serial = this._serial;
        this._after(30000, () => {
            this._request({type: 'ping'}).then(
                () => { if (serial === this._serial && this._running) this._schedulePing(); },
                () => { if (serial === this._serial && this._running) this._fail('timeout'); });
        });
    }

    _fail(code, permanent = false) {
        if (!this._running)
            return;
        this._disconnect();
        this._onStatus(code === 'auth' ? 'auth-error' : code === 'permission' ? 'permission-error' : 'offline');
        if (permanent)
            return;
        const delay = this._retryDelay;
        this._retryDelay = Math.min(this._retryDelay * 2, 60);
        this._after(delay * 1000, () => this._connect());
    }

    _disconnect() {
        this._serial++;
        this._ready = false;
        this._authenticated = false;
        this._subscriptionId = null;
        for (const source of [...this._sources])
            this._removeSource(source);
        this._handshakeTimer = 0;
        for (const request of this._pending.values())
            request.reject(new HomeAssistantError('offline'));
        this._pending.clear();
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._socket) {
            for (const id of this._socketSignals)
                this._socket.disconnect(id);
            this._socketSignals = [];
            if (this._socket.state === Soup.WebsocketState.OPEN)
                this._socket.close(Soup.WebsocketCloseCode.NORMAL, null);
            this._socket = null;
        }
        this._session?.abort();
        this._session = null;
    }

    _after(milliseconds, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            this._sources.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    _removeSource(id) {
        if (id && this._sources.delete(id))
            GLib.Source.remove(id);
    }
}
