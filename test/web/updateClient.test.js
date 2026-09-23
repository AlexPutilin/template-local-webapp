import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateClient } from '../../src/web/scripts/framework/updateClient.js';


test('persists an automatically generated client ID', () => {
    const storage = createStorage();
    const dependencies = createDependencies({ storage });

    const first = createUpdateClient({}, dependencies);
    const second = createUpdateClient({}, dependencies);

    assert.equal(first.clientId, '12345678-1234-4234-9234-123456789abc');
    assert.equal(second.clientId, first.clientId);
    assert.equal(FakeWebSocket.instances.at(-1).url, 'ws://localhost:3000/ws');

    first.close();
    second.close();
});


test('handshakes, subscribes, dispatches updates, and unsubscribes', () => {
    const dependencies = createDependencies();
    const statuses = [];
    const updates = [];
    const client = createUpdateClient({ clientId: 'leitstand-01' }, dependencies);
    const socket = FakeWebSocket.instances.at(-1);

    client.onStatusChange((status) => statuses.push(status));
    const unsubscribe = client.subscribe('sap-data', (data, metadata) => {
        updates.push({ data, metadata });
    });

    socket.open();
    assert.deepEqual(parseSent(socket), [
        { type: 'hello', clientId: 'leitstand-01' }
    ]);

    socket.receive(createReadyMessage('leitstand-01'));
    assert.equal(client.status, 'online');
    assert.deepEqual(parseSent(socket).at(-1), {
        type: 'subscribe',
        topic: 'sap-data'
    });

    socket.receive({
        type: 'update',
        topic: 'sap-data',
        version: 3,
        publishedAt: '2026-09-23T12:00:00.000Z',
        data: { rows: 2 }
    });

    assert.deepEqual(updates, [{
        data: { rows: 2 },
        metadata: {
            topic: 'sap-data',
            version: 3,
            publishedAt: '2026-09-23T12:00:00.000Z'
        }
    }]);

    unsubscribe();
    assert.deepEqual(parseSent(socket).at(-1), {
        type: 'unsubscribe',
        topic: 'sap-data'
    });
    assert.deepEqual(statuses, ['connecting', 'online']);

    client.close();
    assert.equal(client.status, 'closed');
});


test('reconnects and restores active subscriptions', () => {
    const timers = [];
    const dependencies = createDependencies({
        setTimeout: (callback, delay) => {
            const timer = { callback, delay, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimeout: (timer) => {
            timer.cleared = true;
        }
    });
    const statuses = [];
    const client = createUpdateClient({
        clientId: 'leitstand-01',
        reconnect: {
            initialDelayMs: 100,
            maxDelayMs: 1_000,
            factor: 2,
            jitter: 0
        }
    }, dependencies);

    client.onStatusChange((status) => statuses.push(status));
    client.subscribe('sap-data', () => {});

    const firstSocket = FakeWebSocket.instances.at(-1);
    firstSocket.open();
    firstSocket.receive(createReadyMessage('leitstand-01'));
    firstSocket.disconnect();

    assert.equal(client.status, 'offline');
    assert.equal(timers.at(-1).delay, 100);

    timers.at(-1).callback();
    const secondSocket = FakeWebSocket.instances.at(-1);
    assert.notEqual(secondSocket, firstSocket);
    assert.equal(client.status, 'reconnecting');

    secondSocket.open();
    secondSocket.receive(createReadyMessage('leitstand-01'));

    assert.deepEqual(parseSent(secondSocket), [
        { type: 'hello', clientId: 'leitstand-01' },
        { type: 'subscribe', topic: 'sap-data' }
    ]);
    assert.deepEqual(statuses, [
        'connecting',
        'online',
        'offline',
        'reconnecting',
        'online'
    ]);

    client.close();
});


test('rejects protocol-relative paths and invalid ready messages', () => {
    const dependencies = createDependencies();

    assert.throws(() => createUpdateClient({
        clientId: 'browser-01',
        path: '//attacker.example/ws'
    }, dependencies), /same-origin URL path/);
    assert.equal(FakeWebSocket.instances.length, 0);

    const client = createUpdateClient({ clientId: 'browser-01' }, dependencies);
    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    socket.receive({ type: 'ready', clientId: 'browser-01' });

    assert.equal(socket.readyState, 3);
    client.close();
});


function createDependencies(overrides = {}) {
    FakeWebSocket.instances.length = 0;

    return {
        WebSocket: FakeWebSocket,
        storage: createStorage(),
        location: {
            protocol: 'http:',
            host: 'localhost:3000',
            href: 'http://localhost:3000/'
        },
        crypto: {
            randomUUID: () => '12345678-1234-4234-9234-123456789abc'
        },
        random: () => 0.5,
        logger: {
            warn() {},
            error() {}
        },
        setTimeout,
        clearTimeout,
        ...overrides
    };
}


function createStorage() {
    const values = new Map();
    return {
        getItem(key) {
            return values.get(key) ?? null;
        },
        setItem(key, value) {
            values.set(key, value);
        }
    };
}


function parseSent(socket) {
    return socket.sent.map((message) => JSON.parse(message));
}


function createReadyMessage(clientId) {
    return {
        type: 'ready',
        client: {
            id: clientId,
            name: null,
            registered: false
        },
        heartbeatIntervalMs: 15_000
    };
}


class FakeWebSocket {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.listeners = new Map();
        FakeWebSocket.instances.push(this);
    }

    addEventListener(type, listener) {
        let listeners = this.listeners.get(type);
        if (!listeners) {
            listeners = [];
            this.listeners.set(type, listeners);
        }
        listeners.push(listener);
    }

    send(message) {
        this.sent.push(message);
    }

    close() {
        if (this.readyState >= 2) return;
        this.readyState = 3;
        this.emit('close', {});
    }

    open() {
        this.readyState = 1;
        this.emit('open', {});
    }

    receive(message) {
        this.emit('message', { data: JSON.stringify(message) });
    }

    disconnect() {
        this.readyState = 3;
        this.emit('close', {});
    }

    emit(type, event) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}
