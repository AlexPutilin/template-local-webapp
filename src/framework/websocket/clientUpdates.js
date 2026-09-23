import { EventEmitter } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';


const DEFAULT_CONFIG = Object.freeze({
    path: '/ws',
    heartbeatIntervalMs: 15_000,
    handshakeTimeoutMs: 5_000,
    maxIncomingPayloadBytes: 65_536,
    maxBufferedBytes: 10_485_760,
    shutdownGraceMs: 2_000,
    compression: true,
    compressionThresholdBytes: 1_024
});

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;


export class ClientUpdates extends EventEmitter {
    constructor(config = {}) {
        super();

        this.config = normalizeConfig(config);
        this.topics = new Map();
        this.clients = new Map();
        this.connections = new Map();
        this.httpServer = null;
        this.heartbeatTimer = null;
        this.closePromise = null;
        this.closed = false;

        this.webSocketServer = new WebSocketServer({
            noServer: true,
            clientTracking: false,
            maxPayload: this.config.maxIncomingPayloadBytes,
            perMessageDeflate: this.config.compression
                ? {
                    clientNoContextTakeover: true,
                    serverNoContextTakeover: true,
                    threshold: this.config.compressionThresholdBytes
                }
                : false
        });

        this.handleUpgrade = this.handleUpgrade.bind(this);
    }

    registerTopic(name) {
        assertTopic(name);

        if (this.topics.has(name)) {
            throw new Error(`Topic "${name}" is already registered.`);
        }

        this.topics.set(name, {
            name,
            version: 0,
            lastSnapshot: null,
            subscribers: new Set()
        });

        return this;
    }

    registerClient(id, options = {}) {
        assertClientId(id);

        if (!isPlainObject(options)) {
            throw new TypeError('Client options must be an object.');
        }

        const { name = null } = options;

        if (name !== null && (typeof name !== 'string' || name.trim().length === 0)) {
            throw new TypeError('Client name must be a non-empty string or null.');
        }

        const existingClient = this.clients.get(id);
        if (existingClient?.registered) {
            throw new Error(`Client "${id}" is already registered.`);
        }

        if (existingClient) {
            existingClient.name = name?.trim() ?? null;
            existingClient.registered = true;
        } else {
            this.clients.set(id, createClientRecord(id, name?.trim() ?? null, true));
        }

        return this;
    }

    attach(httpServer) {
        if (this.closed) {
            throw new Error('Client updates are already closed.');
        }

        if (!httpServer || typeof httpServer.on !== 'function' || typeof httpServer.off !== 'function') {
            throw new TypeError('attach requires a Node.js HTTP server.');
        }

        if (this.httpServer !== null) {
            throw new Error('Client updates are already attached to an HTTP server.');
        }

        this.httpServer = httpServer;
        this.httpServer.on('upgrade', this.handleUpgrade);
        this.startHeartbeat();

        return this;
    }

    publish(topicName, data) {
        if (this.closed) {
            throw new Error('Client updates are already closed.');
        }

        const topic = this.requireTopic(topicName);

        if (data === undefined || typeof data === 'function' || typeof data === 'symbol') {
            throw new TypeError(`Data for topic "${topicName}" must be JSON-serializable.`);
        }

        const version = topic.version + 1;
        const publishedAt = new Date().toISOString();
        const envelope = {
            type: 'update',
            topic: topicName,
            version,
            publishedAt,
            data
        };

        let payload;
        let hasSerializableData = true;
        try {
            payload = JSON.stringify(envelope, function serializeValue(key, value) {
                if (this === envelope && key === 'data' && value === undefined) {
                    hasSerializableData = false;
                }
                return value;
            });
        } catch (error) {
            throw new TypeError(`Data for topic "${topicName}" must be JSON-serializable.`, {
                cause: error
            });
        }

        if (!hasSerializableData) {
            throw new TypeError(`Data for topic "${topicName}" must be JSON-serializable.`);
        }

        const snapshot = {
            payload,
            byteLength: Buffer.byteLength(payload),
            version,
            publishedAt
        };

        topic.version = version;
        topic.lastSnapshot = snapshot;

        let recipientCount = 0;
        for (const connection of topic.subscribers) {
            if (this.sendSnapshot(connection, snapshot)) {
                recipientCount += 1;
            }
        }

        return Object.freeze({
            topic: topicName,
            version,
            recipientCount
        });
    }

    getClient(id) {
        const client = this.clients.get(id);
        return client ? createPresenceSnapshot(client) : null;
    }

    getClients() {
        const clients = [...this.clients.values()]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(createPresenceSnapshot);

        return Object.freeze(clients);
    }

    getStats() {
        const clientRecords = [...this.clients.values()];
        const topics = [];

        for (const [name, topic] of this.topics) {
            const subscribedClients = new Set();
            for (const connection of topic.subscribers) {
                if (connection.clientId !== null) {
                    subscribedClients.add(connection.clientId);
                }
            }

            topics.push([name, Object.freeze({
                subscribers: topic.subscribers.size,
                clients: subscribedClients.size,
                version: topic.version,
                retained: topic.lastSnapshot !== null,
                publishedAt: topic.lastSnapshot?.publishedAt ?? null
            })]);
        }

        return Object.freeze({
            knownClients: clientRecords.length,
            registeredClients: clientRecords.filter((client) => client.registered).length,
            onlineClients: clientRecords.filter((client) => client.connections.size > 0).length,
            connections: this.connections.size,
            topics: Object.freeze(Object.fromEntries(topics))
        });
    }

    close() {
        if (this.closePromise !== null) {
            return this.closePromise;
        }

        this.closed = true;
        this.stopHeartbeat();

        if (this.httpServer !== null) {
            this.httpServer.off('upgrade', this.handleUpgrade);
            this.httpServer = null;
        }

        this.closePromise = this.finishClose();
        return this.closePromise;
    }

    handleUpgrade(request, socket, head) {
        if (this.closed) {
            rejectUpgrade(socket, 503, 'Service Unavailable');
            return;
        }

        let pathname;
        try {
            pathname = new URL(request.url, 'http://localhost').pathname;
        } catch {
            rejectUpgrade(socket, 400, 'Bad Request');
            return;
        }

        if (pathname !== this.config.path) {
            rejectUpgrade(socket, 404, 'Not Found');
            return;
        }

        if (!hasSameOrigin(request)) {
            rejectUpgrade(socket, 403, 'Forbidden');
            return;
        }

        try {
            this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
                this.acceptConnection(webSocket);
            });
        } catch {
            if (!socket.destroyed) {
                rejectUpgrade(socket, 400, 'Bad Request');
            }
        }
    }

    acceptConnection(socket) {
        if (this.closed) {
            socket.close(1001, 'Server shutting down');
            return;
        }

        const connection = {
            socket,
            clientId: null,
            subscriptions: new Set(),
            alive: true,
            handshakeTimer: null
        };

        this.connections.set(socket, connection);

        connection.handshakeTimer = setTimeout(() => {
            if (connection.clientId === null) {
                this.closeWithProtocolError(
                    connection,
                    1008,
                    'handshake_timeout',
                    'A hello message is required before the handshake timeout.'
                );
            }
        }, this.config.handshakeTimeoutMs);
        connection.handshakeTimer.unref?.();

        socket.on('message', (data, isBinary) => {
            this.handleMessage(connection, data, isBinary);
        });
        socket.on('pong', () => {
            connection.alive = true;
            this.markSeen(connection);
        });
        socket.on('close', () => {
            this.removeConnection(connection);
        });
        socket.on('error', () => {
            // The close event performs all connection cleanup.
        });
    }

    handleMessage(connection, data, isBinary) {
        if (isBinary) {
            this.closeWithProtocolError(
                connection,
                1003,
                'unsupported_data',
                'Binary messages are not supported.'
            );
            return;
        }

        connection.alive = true;
        this.markSeen(connection);

        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            this.closeWithProtocolError(
                connection,
                1007,
                'invalid_json',
                'Messages must contain valid JSON.'
            );
            return;
        }

        if (!isPlainObject(message) || typeof message.type !== 'string') {
            this.closeWithProtocolError(
                connection,
                1008,
                'invalid_message',
                'Messages must be JSON objects with a type.'
            );
            return;
        }

        if (connection.clientId === null) {
            this.handleHello(connection, message);
            return;
        }

        switch (message.type) {
            case 'subscribe':
                this.handleSubscribe(connection, message);
                break;
            case 'unsubscribe':
                this.handleUnsubscribe(connection, message);
                break;
            case 'hello':
                this.closeWithProtocolError(
                    connection,
                    1008,
                    'duplicate_hello',
                    'The hello message may only be sent once per connection.'
                );
                break;
            default:
                this.closeWithProtocolError(
                    connection,
                    1008,
                    'unknown_message_type',
                    `Unknown message type "${message.type}".`
                );
        }
    }

    handleHello(connection, message) {
        if (message.type !== 'hello' || !isValidClientId(message.clientId)) {
            this.closeWithProtocolError(
                connection,
                1008,
                'invalid_hello',
                'The first message must be a hello with a valid clientId.'
            );
            return;
        }

        clearTimeout(connection.handshakeTimer);
        connection.handshakeTimer = null;
        connection.clientId = message.clientId;

        let client = this.clients.get(message.clientId);
        if (!client) {
            client = createClientRecord(message.clientId, null, false);
            this.clients.set(message.clientId, client);
        }

        const wasOnline = client.connections.size > 0;
        const now = new Date().toISOString();

        client.connections.add(connection);
        client.lastSeenAt = now;

        if (!wasOnline) {
            client.connectedAt = now;
            client.disconnectedAt = null;
        }

        this.sendJson(connection, {
            type: 'ready',
            client: {
                id: client.id,
                name: client.name,
                registered: client.registered
            },
            heartbeatIntervalMs: this.config.heartbeatIntervalMs
        });

        if (!wasOnline) {
            this.emitSafely('client:online', createPresenceSnapshot(client));
        }
    }

    handleSubscribe(connection, message) {
        if (!isValidTopic(message.topic)) {
            this.closeWithProtocolError(
                connection,
                1008,
                'invalid_topic',
                'Subscribe messages require a valid topic.'
            );
            return;
        }

        const topic = this.topics.get(message.topic);
        if (!topic) {
            this.sendError(connection, 'unknown_topic', `Unknown topic "${message.topic}".`);
            return;
        }

        const client = this.clients.get(connection.clientId);
        const previousTopics = getClientTopics(client);
        const added = !connection.subscriptions.has(message.topic);

        if (added) {
            connection.subscriptions.add(message.topic);
            topic.subscribers.add(connection);
        }

        this.sendJson(connection, {
            type: 'subscribed',
            topic: message.topic
        });

        if (added && topic.lastSnapshot !== null) {
            this.sendSnapshot(connection, topic.lastSnapshot);
        }

        this.emitSubscriptionsChanged(client, previousTopics);
    }

    handleUnsubscribe(connection, message) {
        if (!isValidTopic(message.topic)) {
            this.closeWithProtocolError(
                connection,
                1008,
                'invalid_topic',
                'Unsubscribe messages require a valid topic.'
            );
            return;
        }

        const topic = this.topics.get(message.topic);
        if (!topic) {
            this.sendError(connection, 'unknown_topic', `Unknown topic "${message.topic}".`);
            return;
        }

        const client = this.clients.get(connection.clientId);
        const previousTopics = getClientTopics(client);

        connection.subscriptions.delete(message.topic);
        topic.subscribers.delete(connection);

        this.sendJson(connection, {
            type: 'unsubscribed',
            topic: message.topic
        });

        this.emitSubscriptionsChanged(client, previousTopics);
    }

    removeConnection(connection) {
        if (!this.connections.delete(connection.socket)) {
            return;
        }

        clearTimeout(connection.handshakeTimer);

        if (connection.clientId === null) {
            return;
        }

        const client = this.clients.get(connection.clientId);
        if (!client) {
            return;
        }

        const previousTopics = getClientTopics(client);

        for (const topicName of connection.subscriptions) {
            this.topics.get(topicName)?.subscribers.delete(connection);
        }
        connection.subscriptions.clear();
        client.connections.delete(connection);

        const now = new Date().toISOString();
        client.lastSeenAt = now;

        if (client.connections.size === 0) {
            client.disconnectedAt = now;
        }

        this.emitSubscriptionsChanged(client, previousTopics);

        if (client.connections.size === 0) {
            this.emitSafely('client:offline', createPresenceSnapshot(client));
        }
    }

    emitSubscriptionsChanged(client, previousTopics) {
        const currentTopics = getClientTopics(client);
        if (setsEqual(previousTopics, currentTopics)) {
            return;
        }

        this.emitSafely('client:subscriptions-changed', createPresenceSnapshot(client));
    }

    emitSafely(eventName, payload) {
        for (const listener of this.rawListeners(eventName)) {
            try {
                listener.call(this, payload);
            } catch (error) {
                console.error(`Client updates listener for "${eventName}" failed:`, error);
            }
        }
    }

    sendSnapshot(connection, snapshot) {
        const { socket } = connection;
        if (socket.readyState !== WebSocket.OPEN) {
            return false;
        }

        if (socket.bufferedAmount + snapshot.byteLength > this.config.maxBufferedBytes) {
            socket.terminate();
            return false;
        }

        try {
            socket.send(snapshot.payload, {
                binary: false,
                compress: this.config.compression
                    && snapshot.byteLength >= this.config.compressionThresholdBytes
            }, (error) => {
                if (error && socket.readyState !== WebSocket.CLOSED) {
                    socket.terminate();
                }
            });
            return true;
        } catch {
            socket.terminate();
            return false;
        }
    }

    sendJson(connection, message) {
        if (connection.socket.readyState !== WebSocket.OPEN) {
            return false;
        }

        const payload = JSON.stringify(message);

        try {
            connection.socket.send(payload, {
                binary: false,
                compress: false
            }, (error) => {
                if (error && connection.socket.readyState !== WebSocket.CLOSED) {
                    connection.socket.terminate();
                }
            });
            return true;
        } catch {
            connection.socket.terminate();
            return false;
        }
    }

    sendError(connection, code, message) {
        this.sendJson(connection, {
            type: 'error',
            code,
            message
        });
    }

    closeWithProtocolError(connection, closeCode, errorCode, message) {
        this.sendError(connection, errorCode, message);
        if (connection.socket.readyState === WebSocket.OPEN) {
            connection.socket.close(closeCode, errorCode);
        }
    }

    markSeen(connection) {
        if (connection.clientId === null) {
            return;
        }

        const client = this.clients.get(connection.clientId);
        if (client) {
            client.lastSeenAt = new Date().toISOString();
        }
    }

    startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            for (const connection of this.connections.values()) {
                if (!connection.alive) {
                    connection.socket.terminate();
                    continue;
                }

                connection.alive = false;
                if (connection.socket.readyState === WebSocket.OPEN) {
                    connection.socket.ping();
                }
            }
        }, this.config.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
    }

    stopHeartbeat() {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    requireTopic(name) {
        assertTopic(name);
        const topic = this.topics.get(name);

        if (!topic) {
            throw new Error(`Unknown topic "${name}".`);
        }

        return topic;
    }

    async finishClose() {
        if (this.connections.size > 0) {
            await new Promise((resolve) => {
                let timeout = null;
                let settled = false;

                const checkConnections = () => {
                    if (settled || this.connections.size !== 0) {
                        return;
                    }

                    settled = true;
                    if (timeout !== null) {
                        clearTimeout(timeout);
                    }
                    resolve();
                };

                timeout = setTimeout(() => {
                    if (settled) {
                        return;
                    }

                    for (const connection of [...this.connections.values()]) {
                        connection.socket.terminate();
                        this.removeConnection(connection);
                    }
                    settled = true;
                    resolve();
                }, this.config.shutdownGraceMs);

                for (const connection of this.connections.values()) {
                    connection.socket.once('close', checkConnections);
                    clearTimeout(connection.handshakeTimer);

                    if (connection.socket.readyState === WebSocket.OPEN) {
                        connection.socket.close(1001, 'Server shutting down');
                    } else if (connection.socket.readyState === WebSocket.CONNECTING) {
                        connection.socket.terminate();
                    }
                }

                checkConnections();
            });
        }

        await closeWebSocketServer(this.webSocketServer);
    }
}


export default function createClientUpdates(registerUpdates, config = {}) {
    if (typeof registerUpdates !== 'function') {
        throw new TypeError('createClientUpdates requires a registration function.');
    }

    const clientUpdates = new ClientUpdates(config);
    registerUpdates(clientUpdates);
    return clientUpdates;
}


function normalizeConfig(config) {
    if (!isPlainObject(config)) {
        throw new TypeError('WebSocket config must be an object.');
    }

    const normalized = {
        ...DEFAULT_CONFIG,
        ...config
    };

    if (
        typeof normalized.path !== 'string'
        || !normalized.path.startsWith('/')
        || normalized.path.startsWith('//')
        || normalized.path.includes('\\')
        || normalized.path.includes('?')
        || normalized.path.includes('#')
    ) {
        throw new TypeError(
            'WebSocket path must be a same-origin URL path beginning with one "/".'
        );
    }

    validatePositiveInteger(normalized.heartbeatIntervalMs, 'heartbeatIntervalMs');
    validatePositiveInteger(normalized.handshakeTimeoutMs, 'handshakeTimeoutMs');
    validatePositiveInteger(normalized.maxIncomingPayloadBytes, 'maxIncomingPayloadBytes');
    validatePositiveInteger(normalized.maxBufferedBytes, 'maxBufferedBytes');
    validateNonNegativeInteger(normalized.shutdownGraceMs, 'shutdownGraceMs');
    validateNonNegativeInteger(normalized.compressionThresholdBytes, 'compressionThresholdBytes');

    if (typeof normalized.compression !== 'boolean') {
        throw new TypeError('compression must be a boolean.');
    }

    return Object.freeze(normalized);
}


function validatePositiveInteger(value, optionName) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${optionName} must be a positive integer.`);
    }
}


function validateNonNegativeInteger(value, optionName) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${optionName} must be a non-negative integer.`);
    }
}


function assertClientId(value) {
    if (!isValidClientId(value)) {
        throw new TypeError(
            'Client ID must be 1 to 128 characters and contain only letters, numbers, ".", "_", ":" or "-".'
        );
    }
}


function assertTopic(value) {
    if (!isValidTopic(value)) {
        throw new TypeError(
            'Topic must be 1 to 128 characters and contain only letters, numbers, ".", "_", ":", "/" or "-".'
        );
    }
}


function isValidClientId(value) {
    return typeof value === 'string' && CLIENT_ID_PATTERN.test(value);
}


function isValidTopic(value) {
    return typeof value === 'string' && TOPIC_PATTERN.test(value);
}


function isPlainObject(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}


function createClientRecord(id, name, registered) {
    return {
        id,
        name,
        registered,
        connections: new Set(),
        connectedAt: null,
        lastSeenAt: null,
        disconnectedAt: null
    };
}


function createPresenceSnapshot(client) {
    const topics = Object.freeze([...getClientTopics(client)].sort());

    return Object.freeze({
        id: client.id,
        name: client.name,
        registered: client.registered,
        online: client.connections.size > 0,
        connectionCount: client.connections.size,
        topics,
        connectedAt: client.connectedAt,
        lastSeenAt: client.lastSeenAt,
        disconnectedAt: client.disconnectedAt
    });
}


function getClientTopics(client) {
    const topics = new Set();

    for (const connection of client.connections) {
        for (const topic of connection.subscriptions) {
            topics.add(topic);
        }
    }

    return topics;
}


function setsEqual(left, right) {
    if (left.size !== right.size) {
        return false;
    }

    for (const value of left) {
        if (!right.has(value)) {
            return false;
        }
    }

    return true;
}


function hasSameOrigin(request) {
    const origin = request.headers.origin;
    if (origin === undefined) {
        return true;
    }

    if (typeof origin !== 'string' || typeof request.headers.host !== 'string') {
        return false;
    }

    try {
        const protocol = request.socket.encrypted ? 'https:' : 'http:';
        const expectedOrigin = new URL(`${protocol}//${request.headers.host}`).origin;
        return new URL(origin).origin === expectedOrigin;
    } catch {
        return false;
    }
}


function rejectUpgrade(socket, statusCode, statusText) {
    if (socket.destroyed) {
        return;
    }

    socket.end(
        `HTTP/1.1 ${statusCode} ${statusText}\r\n`
        + 'Connection: close\r\n'
        + 'Content-Length: 0\r\n'
        + '\r\n'
    );
}


function closeWebSocketServer(webSocketServer) {
    return new Promise((resolve, reject) => {
        webSocketServer.close((error) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}
