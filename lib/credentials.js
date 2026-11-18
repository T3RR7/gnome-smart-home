// SPDX-License-Identifier: GPL-3.0-or-later
import Secret from 'gi://Secret?version=1';

const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.gnome-smart-home',
    Secret.SchemaFlags.NONE, {server: Secret.SchemaAttributeType.STRING});

export function lookupToken(server, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, {server}, cancellable, (_source, result) => {
            try {
                resolve(Secret.password_lookup_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

export function storeToken(server, token, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, {server}, Secret.COLLECTION_DEFAULT,
            'Gnome Smart Home — Home Assistant', token, cancellable, (_source, result) => {
                try {
                    resolve(Secret.password_store_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

export function clearToken(server, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_clear(SCHEMA, {server}, cancellable, (_source, result) => {
            try {
                resolve(Secret.password_clear_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}
