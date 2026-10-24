/** Route table entries for the demo platform: method, a path with :params, the handler, the roles allowed and whether it reads a JSON body. */

const compile = path => new RegExp(`^${path.replace(/\./g, '\\.').replace(/:([a-z]+)/g, '(?<$1>[A-Za-z0-9_-]{1,64})')}$`);

/**
 * `roles` null means anyone, signed in or not; otherwise the signed-in account's role must be listed. `bodyLimit` raises the
 * JSON body cap for one route, and `beacon` also accepts the text/plain body navigator.sendBeacon sends.
 */
export const route = (method, path, handler, { roles = null, body = false, bodyLimit, beacon = false } = {}) => ({ method, pattern: compile(path), handler, roles, body, bodyLimit, beacon });

export const ANY = Object.freeze(['buyer', 'lender', 'provider', 'admin']);
export const BUYING_ROLES = Object.freeze(['buyer', 'lender', 'provider']);
export const PROVIDER = Object.freeze(['provider']);
export const ADMIN = Object.freeze(['admin']);
