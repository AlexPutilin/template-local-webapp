import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import createClientUpdates, { ClientUpdates } from '../../../src/framework/websocket/clientUpdates.js';


test('registers topics and known clients and retains published snapshots', async () => {
    assert.throws(() => new ClientUpdates({ path: '//attacker.example/ws' }), /same-origin URL path/);

    const updates = new ClientUpdates();

    updates.registerTopic('sap-data');
    updates.registerClient('leitstand-01', { name: 'Leitstand 1' });

    assert.throws(() => updates.registerTopic('sap-data'), /already registered/);
    assert.throws(() => updates.registerClient('leitstand-01'), /already registered/);
    assert.throws(() => updates.publish('unknown', {}), /Unknown topic/);
    assert.throws(() => updates.publish('sap-data', undefined), /JSON-serializable/);

    assert.deepEqual(updates.publish('sap-data', { rows: 1 }), {
        topic: 'sap-data',
        version: 1,
        recipientCount: 0
    });
    assert.deepEqual(updates.getClient('leitstand-01'), {
        id: 'leitstand-01',
        name: 'Leitstand 1',
        registered: true,
        online: false,
        connectionCount: 0,
        topics: [],
        connectedAt: null,
        lastSeenAt: null,
        disconnectedAt: null
    });
    assert.deepEqual(updates.getStats(), {
        knownClients: 1,
        registeredClients: 1,
        onlineClients: 0,
        connections: 0,
        topics: {
            'sap-data': {
                subscribers: 0,
                clients: 0,
                version: 1,
                retained: true,
                publishedAt: updates.getStats().topics['sap-data'].publishedAt
            }
        }
    });

    await updates.close();
    assert.throws(() => updates.publish('sap-data', {}), /already closed/);
});


test('delivers retained topic updates and aggregates presence by client ID', async (t) => {
    const online = [];
    const offline = [];
    const subscriptionChanges = [];
    const fixture = await createFixture((updates) => {
        updates.registerTopic('sap-data');
        updates.registerTopic('alerts');
        updates.registerClient('leitstand-01', { name: 'Leitstand 1' });
    });
    t.after(() => fixture.close());

    fixture.updates.on('client:online', (client) => online.push(client.id));
    fixture.updates.on('client:offline', (client) => offline.push(client.id));
    fixture.updates.on('client:subscriptions-changed', (client) => {
        subscriptionChanges.push({ id: client.id, topics: [...client.topics] });
    });

    const first = await fixture.connect('leitstand-01');
    first.send({ type: 'subscribe', topic: 'sap-data' });
    assert.deepEqual(await first.next(), {
        type: 'subscribed',
        topic: 'sap-data'
    });

    const publication = fixture.updates.publish('sap-data', {
        rows: [{ id: 1 }]
    });
    assert.equal(publication.recipientCount, 1);
    assert.deepEqual(await first.next(), {
        type: 'update',
        topic: 'sap-data',
        version: 1,
        publishedAt: publicationTimestamp(fixture.updates, 'sap-data'),
        data: { rows: [{ id: 1 }] }
    });

    const secondTab = await fixture.connect('leitstand-01');
    secondTab.send({ type: 'subscribe', topic: 'sap-data' });
    assert.equal((await secondTab.next()).type, 'subscribed');
    const retained = await secondTab.next();
    assert.equal(retained.type, 'update');
    assert.equal(retained.version, 1);
    assert.deepEqual(retained.data, { rows: [{ id: 1 }] });

    const presence = fixture.updates.getClient('leitstand-01');
    assert.equal(presence.online, true);
    assert.equal(presence.connectionCount, 2);
    assert.deepEqual(presence.topics, ['sap-data']);
    assert.deepEqual(online, ['leitstand-01']);

    await first.close();
    assert.equal(fixture.updates.getClient('leitstand-01').online, true);
    assert.deepEqual(offline, []);

    await secondTab.close();
    await waitFor(() => fixture.updates.getClient('leitstand-01').online === false);
    assert.equal(fixture.updates.getClient('leitstand-01').online, false);
    assert.deepEqual(offline, ['leitstand-01']);
    assert.ok(subscriptionChanges.some((event) => event.topics.includes('sap-data')));
    assert.ok(subscriptionChanges.some((event) => event.topics.length === 0));
});


test('delivers each publication only to the subscribed topic', async (t) => {
    const fixture = await createFixture((updates) => {
        updates.registerTopic('sap-data');
        updates.registerTopic('alerts');
    });
    t.after(() => fixture.close());

    const sapClient = await fixture.connect('sap-client');
    const alertsClient = await fixture.connect('alerts-client');

    sapClient.send({ type: 'subscribe', topic: 'sap-data' });
    alertsClient.send({ type: 'subscribe', topic: 'alerts' });
    await Promise.all([sapClient.next(), alertsClient.next()]);

    const publication = fixture.updates.publish('sap-data', { rows: 10 });
    const update = await sapClient.next();
    const wrongTopicReceived = await Promise.race([
        alertsClient.next().then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 25))
    ]);

    assert.equal(publication.recipientCount, 1);
    assert.equal(update.topic, 'sap-data');
    assert.equal(wrongTopicReceived, false);

    await Promise.all([sapClient.close(), alertsClient.close()]);
});


test('keeps unknown-topic errors recoverable and closes malformed messages', async (t) => {
    const fixture = await createFixture((updates) => {
        updates.registerTopic('sap-data');
    });
    t.after(() => fixture.close());

    const peer = await fixture.connect('browser-01');
    peer.send({ type: 'subscribe', topic: 'missing' });

    assert.deepEqual(await peer.next(), {
        type: 'error',
        code: 'unknown_topic',
        message: 'Unknown topic "missing".'
    });
    assert.equal(peer.socket.readyState, WebSocket.OPEN);

    const closePromise = once(peer.socket, 'close');
    peer.socket.send('{broken json');
    const [code] = await closePromise;
    assert.equal(code, 1007);
});


test('enforces the incoming message size and hello timeout', async (t) => {
    const fixture = await createFixture(() => {}, {
        maxIncomingPayloadBytes: 128,
        handshakeTimeoutMs: 30
    });
    t.after(() => fixture.close());

    const oversized = await fixture.connect('browser-01');
    const oversizedClose = once(oversized.socket, 'close');
    oversized.socket.send(JSON.stringify({
        type: 'subscribe',
        topic: `topic-${'x'.repeat(256)}`
    }));
    const [oversizedCode] = await oversizedClose;
    assert.equal(oversizedCode, 1009);

    const silentSocket = new WebSocket(fixture.webSocketUrl, {
        origin: fixture.httpOrigin
    });
    await once(silentSocket, 'open');
    const [timeoutCode, timeoutReason] = await once(silentSocket, 'close');
    assert.equal(timeoutCode, 1008);
    assert.equal(timeoutReason.toString(), 'handshake_timeout');
});


test('rejects cross-origin browser upgrades', async (t) => {
    const fixture = await createFixture(() => {});
    t.after(() => fixture.close());

    const responseStatus = await new Promise((resolve, reject) => {
        const socket = new WebSocket(fixture.webSocketUrl, {
            origin: 'http://malicious.example'
        });

        socket.once('unexpected-response', (_request, response) => {
            response.resume();
            resolve(response.statusCode);
        });
        socket.once('error', () => {});
        socket.once('open', () => reject(new Error('Cross-origin WebSocket unexpectedly opened.')));
    });

    assert.equal(responseStatus, 403);
});


test('terminates a client that does not answer heartbeat pings', {
    timeout: 2_000
}, async (t) => {
    const fixture = await createFixture((updates) => {
        updates.registerClient('silent-client', { name: 'Silent client' });
    }, {
        heartbeatIntervalMs: 20,
        handshakeTimeoutMs: 200
    });
    t.after(() => fixture.close());

    const peer = await fixture.connect('silent-client', { autoPong: false });
    await once(peer.socket, 'close');
    await waitFor(() => fixture.updates.getClient('silent-client').online === false);

    assert.equal(fixture.updates.getClient('silent-client').online, false);
});


test('disconnects a connection before adding excessive buffered data', async () => {
    const updates = new ClientUpdates({ maxBufferedBytes: 10 });
    let terminated = false;
    const connection = {
        socket: {
            readyState: WebSocket.OPEN,
            bufferedAmount: 8,
            terminate() {
                terminated = true;
            }
        }
    };

    assert.equal(updates.sendSnapshot(connection, {
        payload: 'abc',
        byteLength: 3
    }), false);
    assert.equal(terminated, true);

    await updates.close();
});


test('delivers an exact 5 MiB snapshot to 20 compressed clients', {
    timeout: 15_000
}, async (t) => {
    const fixture = await createFixture((updates) => {
        updates.registerTopic('sap-data');
    });
    t.after(() => fixture.close());

    const peers = await Promise.all(
        Array.from({ length: 20 }, (_, index) => fixture.connect(`browser-${index}`))
    );

    await Promise.all(peers.map(async (peer) => {
        peer.send({ type: 'subscribe', topic: 'sap-data' });
        assert.equal((await peer.next()).type, 'subscribed');
    }));

    const blob = 'x'.repeat(5 * 1024 * 1024);
    const publication = fixture.updates.publish('sap-data', { blob });
    const messages = await Promise.all(peers.map((peer) => peer.next()));

    assert.equal(publication.recipientCount, 20);
    assert.ok(peers.every((peer) => peer.socket.extensions.includes('permessage-deflate')));
    assert.ok(messages.every((message) => message.data.blob === blob));

    await Promise.all(peers.map((peer) => peer.close()));
});


async function createFixture(registerUpdates, config = {}) {
    const updates = createClientUpdates(registerUpdates, {
        heartbeatIntervalMs: 5_000,
        handshakeTimeoutMs: 1_000,
        shutdownGraceMs: 100,
        ...config
    });
    const server = http.createServer();
    updates.attach(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    const httpOrigin = `http://127.0.0.1:${address.port}`;
    const webSocketUrl = `ws://127.0.0.1:${address.port}/ws`;

    return {
        updates,
        server,
        httpOrigin,
        webSocketUrl,
        connect: (clientId, options = {}) => connectPeer({
            clientId,
            httpOrigin,
            webSocketUrl,
            options
        }),
        async close() {
            await updates.close();
            if (server.listening) {
                await new Promise((resolve, reject) => {
                    server.close((error) => error ? reject(error) : resolve());
                });
            }
        }
    };
}


async function connectPeer({ clientId, httpOrigin, webSocketUrl, options }) {
    const socket = new WebSocket(webSocketUrl, {
        origin: httpOrigin,
        perMessageDeflate: true,
        ...options
    });
    const reader = createMessageReader(socket);

    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'hello', clientId }));
    const ready = await reader.next();
    assert.equal(ready.type, 'ready');

    return {
        socket,
        next: reader.next,
        send(message) {
            socket.send(JSON.stringify(message));
        },
        async close() {
            if (socket.readyState === WebSocket.CLOSED) return;
            const closed = once(socket, 'close');
            socket.close(1000, 'Test complete');
            await closed;
        }
    };
}


function createMessageReader(socket) {
    const messages = [];
    const waiters = [];

    socket.on('message', (data, isBinary) => {
        assert.equal(isBinary, false);
        const message = JSON.parse(data.toString());
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else messages.push(message);
    });

    return {
        next() {
            if (messages.length > 0) {
                return Promise.resolve(messages.shift());
            }
            return new Promise((resolve) => waiters.push(resolve));
        }
    };
}


function publicationTimestamp(updates, topic) {
    return updates.getStats().topics[topic].publishedAt;
}


async function waitFor(predicate, timeoutMs = 1_000) {
    const deadline = Date.now() + timeoutMs;

    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out while waiting for the expected state.');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
