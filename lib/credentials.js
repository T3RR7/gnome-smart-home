// SPDX-License-Identifier: MIT
import Secret from 'gi://Secret?version=1';

// Scope each secret to its server URL. GSettings stores that URL but no token.
function credentialSchema() {
    return new Secret.Schema('org.gnome.shell.extensions.gnome-smart-home',
        Secret.SchemaFlags.NONE, {server: Secret.SchemaAttributeType.STRING});
}

export function lookupToken(server, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(credentialSchema(), {server}, cancellable, (_source, result) => {
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
        Secret.password_store(credentialSchema(), {server}, Secret.COLLECTION_DEFAULT,
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
        Secret.password_clear(credentialSchema(), {server}, cancellable, (_source, result) => {
            try {
                resolve(Secret.password_clear_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}
