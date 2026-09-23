const DEFAULT_STORAGE_KEY = 'client-updates.client-id';
const DEFAULT_PATH = '/ws';
const OPEN_STATE = 1;

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;


/**
 * Creates a reconnecting browser client for the framework's update protocol.
 *
 * @param {object} [options]
 * @param {string} [options.clientId]
 * @param {string} [options.url]
 * @param {string} [options.path]
 * @param {string} [options.storageKey]
 * @param {object} [options.reconnect]
 * @param {number} [options.reconnect.initialDelayMs]
 * @param {number} [options.reconnect.maxDelayMs]
 * @param {number} [options.reconnect.factor]
 * @param {number} [options.reconnect.jitter]
 * @param {object} [dependencies]
 * @returns {{
 *     readonly clientId: string,
 *     readonly status: string,
 *     subscribe: (topic: string, handler: Function) => Function,
 *     onStatusChange: (handler: Function) => Function,
 *     close: () => void
 * }}
 */
export function createUpdateClient(options = {}, dependencies = {}) {
    assertPlainObject(options, 'options');
    assertPlainObject(dependencies, 'dependencies');

    const reconnect = resolveReconnectOptions(options.reconnect);
    const environment = resolveEnvironment(dependencies);
    const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;

    if (typeof storageKey !== 'string' || storageKey.length === 0) {
        throw new TypeError('storageKey must be a non-empty string.');
    }

    const clientId = options.clientId === undefined
        ? getOrCreateClientId(environment.storage, storageKey, environment.crypto)
        : validateClientId(options.clientId);
    const url = resolveWebSocketUrl(options.url, options.path ?? DEFAULT_PATH, environment.location);

    /** @type {Map<string, Set<{ handler: Function }>>} */
    const subscriptions = new Map();
    const statusHandlers = new Set();

    let socket = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let ready = false;
    let intentionallyClosed = false;
    let status = 'connecting';

    const api = Object.freeze({
        clientId,
        get status() {
            return status;
        },
        subscribe,
        onStatusChange,
        close
    });

    connect(false);

    return api;


    function subscribe(topic, handler) {
        topic = validateTopic(topic);

        if (typeof handler !== 'function') {
            throw new TypeError('Subscription handler must be a function.');
        }

        if (intentionallyClosed) {
            throw new Error('Cannot subscribe after the update client has been closed.');
        }

        const registration = { handler };
        let handlers = subscriptions.get(topic);

        if (!handlers) {
            handlers = new Set();
            subscriptions.set(topic, handlers);

            if (ready) {
                send({ type: 'subscribe', topic });
            }
        }

        handlers.add(registration);

        let subscribed = true;
        return () => {
            if (!subscribed) return;
            subscribed = false;

            const currentHandlers = subscriptions.get(topic);
            if (!currentHandlers) return;

            currentHandlers.delete(registration);
            if (currentHandlers.size > 0) return;

            subscriptions.delete(topic);
            if (ready) {
                send({ type: 'unsubscribe', topic });
            }
        };
    }


    function onStatusChange(handler) {
        if (typeof handler !== 'function') {
            throw new TypeError('Status handler must be a function.');
        }

        statusHandlers.add(handler);
        callHandler(handler, status);

        let listening = true;
        return () => {
            if (!listening) return;
            listening = false;
            statusHandlers.delete(handler);
        };
    }


    function close() {
        if (intentionallyClosed) return;

        intentionallyClosed = true;
        ready = false;

        if (reconnectTimer !== null) {
            environment.clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        const currentSocket = socket;
        socket = null;

        if (currentSocket && currentSocket.readyState < 2) {
            currentSocket.close(1000, 'Client closed');
        }

        setStatus('closed');
    }


    function connect(isReconnect) {
        if (intentionallyClosed || socket !== null) return;

        setStatus(isReconnect ? 'reconnecting' : 'connecting');

        let candidate;
        try {
            candidate = new environment.WebSocket(url);
        } catch (error) {
            environment.logger?.warn?.('Unable to create update WebSocket.', error);
            setStatus('offline');
            scheduleReconnect();
            return;
        }

        socket = candidate;

        candidate.addEventListener('open', () => {
            if (candidate !== socket || intentionallyClosed) return;
            send({ type: 'hello', clientId });
        });

        candidate.addEventListener('message', (event) => {
            if (candidate !== socket || intentionallyClosed) return;
            handleMessage(candidate, event.data);
        });

        candidate.addEventListener('error', () => {
            if (candidate !== socket || intentionallyClosed) return;
            try {
                candidate.close();
            } catch {
                handleDisconnect(candidate);
            }
        });

        candidate.addEventListener('close', () => {
            handleDisconnect(candidate);
        });
    }


    function handleMessage(candidate, rawMessage) {
        if (typeof rawMessage !== 'string') {
            closeForProtocolError(candidate, 1003, 'Text messages required');
            return;
        }

        let message;
        try {
            message = JSON.parse(rawMessage);
        } catch {
            closeForProtocolError(candidate, 1002, 'Invalid JSON');
            return;
        }

        if (!isPlainObject(message) || typeof message.type !== 'string') {
            closeForProtocolError(candidate, 1002, 'Invalid message');
            return;
        }

        switch (message.type) {
            case 'ready':
                handleReady(candidate, message);
                break;
            case 'subscribed':
            case 'unsubscribed':
                if (!isValidTopic(message.topic)) {
                    closeForProtocolError(candidate, 1002, 'Invalid topic');
                }
                break;
            case 'update':
                handleUpdate(candidate, message);
                break;
            case 'error':
                handleServerError(candidate, message);
                break;
            default:
                closeForProtocolError(candidate, 1002, 'Unknown message type');
        }
    }


    function handleReady(candidate, message) {
        if (
            ready
            || !isPlainObject(message.client)
            || message.client.id !== clientId
            || (message.client.name !== null && typeof message.client.name !== 'string')
            || typeof message.client.registered !== 'boolean'
            || !Number.isSafeInteger(message.heartbeatIntervalMs)
            || message.heartbeatIntervalMs <= 0
        ) {
            closeForProtocolError(candidate, 1002, 'Invalid ready');
            return;
        }

        ready = true;
        reconnectAttempt = 0;
        setStatus('online');

        for (const topic of subscriptions.keys()) {
            send({ type: 'subscribe', topic });
        }
    }


    function handleUpdate(candidate, message) {
        if (
            !ready
            || !isValidTopic(message.topic)
            || !Number.isSafeInteger(message.version)
            || message.version < 1
            || typeof message.publishedAt !== 'string'
            || !Object.hasOwn(message, 'data')
        ) {
            closeForProtocolError(candidate, 1002, 'Invalid update');
            return;
        }

        const handlers = subscriptions.get(message.topic);
        if (!handlers) return;

        const metadata = Object.freeze({
            topic: message.topic,
            version: message.version,
            publishedAt: message.publishedAt
        });

        for (const { handler } of [...handlers]) {
            callHandler(handler, message.data, metadata);
        }
    }


    function handleServerError(candidate, message) {
        if (typeof message.message !== 'string') {
            closeForProtocolError(candidate, 1002, 'Invalid error');
            return;
        }

        environment.logger?.warn?.(`Update server error: ${message.message}`);
    }


    function handleDisconnect(candidate) {
        if (candidate !== socket) return;

        socket = null;
        ready = false;

        if (intentionallyClosed) return;

        setStatus('offline');
        scheduleReconnect();
    }


    function scheduleReconnect() {
        if (intentionallyClosed || reconnectTimer !== null) return;

        const exponentialDelay = Math.min(
            reconnect.maxDelayMs,
            reconnect.initialDelayMs * reconnect.factor ** reconnectAttempt
        );
        const jitterMultiplier = 1 + ((environment.random() * 2) - 1) * reconnect.jitter;
        const delay = Math.max(0, Math.round(exponentialDelay * jitterMultiplier));

        reconnectAttempt += 1;
        reconnectTimer = environment.setTimeout(() => {
            reconnectTimer = null;
            connect(true);
        }, delay);
    }


    function send(message) {
        if (!socket || socket.readyState !== OPEN_STATE) return false;

        try {
            socket.send(JSON.stringify(message));
            return true;
        } catch (error) {
            environment.logger?.warn?.('Unable to send update WebSocket message.', error);
            try {
                socket.close();
            } catch {
                handleDisconnect(socket);
            }
            return false;
        }
    }


    function closeForProtocolError(candidate, code, reason) {
        try {
            candidate.close(code, reason);
        } catch {
            handleDisconnect(candidate);
        }
    }


    function setStatus(nextStatus) {
        if (status === nextStatus) return;
        status = nextStatus;

        for (const handler of [...statusHandlers]) {
            callHandler(handler, status);
        }
    }


    function callHandler(handler, ...args) {
        try {
            handler(...args);
        } catch (error) {
            environment.logger?.error?.('Update client handler failed.', error);
        }
    }
}


function resolveReconnectOptions(value) {
    if (value === undefined) value = {};
    assertPlainObject(value, 'reconnect');

    const options = {
        initialDelayMs: value.initialDelayMs ?? 1_000,
        maxDelayMs: value.maxDelayMs ?? 30_000,
        factor: value.factor ?? 2,
        jitter: value.jitter ?? 0.2
    };

    assertNonNegativeNumber(options.initialDelayMs, 'reconnect.initialDelayMs');
    assertNonNegativeNumber(options.maxDelayMs, 'reconnect.maxDelayMs');

    if (options.maxDelayMs < options.initialDelayMs) {
        throw new RangeError('reconnect.maxDelayMs must be greater than or equal to initialDelayMs.');
    }
    if (!Number.isFinite(options.factor) || options.factor < 1) {
        throw new RangeError('reconnect.factor must be a finite number greater than or equal to 1.');
    }
    if (!Number.isFinite(options.jitter) || options.jitter < 0 || options.jitter > 1) {
        throw new RangeError('reconnect.jitter must be a finite number between 0 and 1.');
    }

    return options;
}


function resolveEnvironment(dependencies) {
    const WebSocketImplementation = dependencies.WebSocket ?? globalThis.WebSocket;
    const setTimeoutImplementation = dependencies.setTimeout ?? globalThis.setTimeout;
    const clearTimeoutImplementation = dependencies.clearTimeout ?? globalThis.clearTimeout;

    if (typeof WebSocketImplementation !== 'function') {
        throw new TypeError('A WebSocket implementation is required.');
    }
    if (typeof setTimeoutImplementation !== 'function' || typeof clearTimeoutImplementation !== 'function') {
        throw new TypeError('setTimeout and clearTimeout implementations are required.');
    }

    return {
        WebSocket: WebSocketImplementation,
        storage: dependencies.storage ?? globalThis.localStorage,
        location: dependencies.location ?? globalThis.location,
        crypto: dependencies.crypto ?? globalThis.crypto,
        random: dependencies.random ?? Math.random,
        logger: dependencies.logger ?? globalThis.console,
        setTimeout: setTimeoutImplementation,
        clearTimeout: clearTimeoutImplementation
    };
}


function resolveWebSocketUrl(explicitUrl, path, location) {
    if (
        typeof path !== 'string'
        || !path.startsWith('/')
        || path.startsWith('//')
        || path.includes('\\')
        || path.includes('?')
        || path.includes('#')
    ) {
        throw new TypeError('path must be a same-origin URL path beginning with one "/".');
    }

    let endpoint;

    try {
        if (explicitUrl !== undefined) {
            if (typeof explicitUrl !== 'string' || explicitUrl.length === 0) {
                throw new TypeError('url must be a non-empty string.');
            }
            endpoint = location?.href
                ? new URL(explicitUrl, location.href)
                : new URL(explicitUrl);
        } else {
            if (!location?.protocol || !location?.host) {
                throw new TypeError('A browser location or explicit WebSocket URL is required.');
            }
            endpoint = new URL(path, `${location.protocol}//${location.host}`);
        }
    } catch (error) {
        if (error instanceof TypeError && error.message.startsWith('A browser location')) {
            throw error;
        }
        throw new TypeError('url must be a valid WebSocket URL.', { cause: error });
    }

    if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
    if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';

    if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
        throw new TypeError('url must use the ws: or wss: protocol.');
    }

    return endpoint.href;
}


function getOrCreateClientId(storage, storageKey, cryptoImplementation) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
        throw new TypeError('localStorage is required when clientId is not provided.');
    }

    let storedId;
    try {
        storedId = storage.getItem(storageKey);
    } catch (error) {
        throw new Error('Unable to read the persisted update client ID.', { cause: error });
    }

    const normalizedStoredId = typeof storedId === 'string' ? storedId.trim() : null;
    if (normalizedStoredId !== null && isValidClientId(normalizedStoredId)) {
        if (normalizedStoredId !== storedId) {
            try {
                storage.setItem(storageKey, normalizedStoredId);
            } catch (error) {
                throw new Error('Unable to persist the normalized update client ID.', { cause: error });
            }
        }
        return normalizedStoredId;
    }

    const clientId = createUuid(cryptoImplementation);

    try {
        storage.setItem(storageKey, clientId);
    } catch (error) {
        throw new Error('Unable to persist the update client ID.', { cause: error });
    }

    return clientId;
}


function createUuid(cryptoImplementation) {
    if (typeof cryptoImplementation?.randomUUID === 'function') {
        return cryptoImplementation.randomUUID();
    }

    if (typeof cryptoImplementation?.getRandomValues !== 'function') {
        throw new TypeError('crypto.randomUUID or crypto.getRandomValues is required to create a client ID.');
    }

    const bytes = new Uint8Array(16);
    cryptoImplementation.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));

    return [
        hex.slice(0, 4).join(''),
        hex.slice(4, 6).join(''),
        hex.slice(6, 8).join(''),
        hex.slice(8, 10).join(''),
        hex.slice(10, 16).join('')
    ].join('-');
}


function validateClientId(value) {
    const normalizedValue = typeof value === 'string' ? value.trim() : value;
    if (!isValidClientId(normalizedValue)) {
        throw new TypeError('clientId must contain 1-128 letters, numbers, dots, underscores, colons, or hyphens.');
    }
    return normalizedValue;
}


function validateTopic(value) {
    const normalizedValue = typeof value === 'string' ? value.trim() : value;
    if (!isValidTopic(normalizedValue)) {
        throw new TypeError('topic must contain 1-128 letters, numbers, dots, underscores, colons, slashes, or hyphens.');
    }
    return normalizedValue;
}


function isValidClientId(value) {
    return typeof value === 'string' && CLIENT_ID_PATTERN.test(value);
}


function isValidTopic(value) {
    return typeof value === 'string' && TOPIC_PATTERN.test(value);
}


function assertPlainObject(value, name) {
    if (!isPlainObject(value)) {
        throw new TypeError(`${name} must be an object.`);
    }
}


function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}


function assertNonNegativeNumber(value, name) {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be a finite non-negative number.`);
    }
}
