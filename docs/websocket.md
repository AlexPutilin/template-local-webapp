# WebSocket Layer

## Purpose

The WebSocket layer under `src/framework/websocket/` provides reusable real-time updates from the Node.js process to browser clients. Applications publish complete JSON snapshots to registered topics; browsers receive only the topics they subscribe to.

The layer is transport infrastructure. Reading SAP exports, parsing files, preparing domain data, and deciding when to publish belong under `src/application/`.

```text
src/framework/websocket/
├─ index.js           → public exports for the layer
└─ clientUpdates.js   → topics, connections, presence, and delivery

src/web/
└─ scripts/framework/
   └─ updateClient.js → browser connection and subscription helper
```

The implementation is intended for small local applications with roughly 20 concurrent browser clients and complete JSON snapshots of about 5 MiB every 20 to 30 seconds. It shares the existing HTTP server and therefore uses the same host and port.

## Update Flow

```text
Scheduled task or application workflow
→ prepare a complete JSON snapshot
→ clientUpdates.publish(topic, data)
→ serialize once and retain the latest topic update in memory
→ deliver it to every subscribed connection
→ browser subscription handler
```

Updates are state snapshots, not commands. There are no acknowledgements, delivery history, or guaranteed processing. If a browser disconnects or cannot keep up, it reconnects, subscribes again, and receives the newest retained snapshot.

## Server Setup

Create the update layer before routes and scheduled tasks so both can receive it as an application dependency. Attach it to the Node.js HTTP server before listening:

```js
import config from '../app.config.json' with { type: 'json' };
import registerRoutes from '#application/routes/routes.js';
import registerTasks from '#application/tasks/index.js';
import createHttpServer from '#framework/http/http.js';
import createTaskScheduler from '#framework/scheduler/taskScheduler.js';
import createClientUpdates from '#framework/websocket/index.js';

const clientUpdates = createClientUpdates((updates) => {
    updates.registerTopic('sap-data');

    updates.registerClient('leitstand-01', {
        name: 'Leitstand 1'
    });
}, config.websocket);

const httpServer = createHttpServer((router) => {
    registerRoutes(router, { clientUpdates });
});

const taskScheduler = createTaskScheduler((scheduler) => {
    registerTasks(scheduler, { clientUpdates });
});

clientUpdates.attach(httpServer);
taskScheduler.start();
httpServer.listen(config.http.port, config.http.host);
```

An application does not need to register every browser in advance. Registered clients provide stable names for known devices; unknown client IDs are accepted and tracked dynamically until the process exits.

## Configuration

Add the following section to `app.config.json`:

```json
{
    "websocket": {
        "path": "/ws",
        "heartbeatIntervalMs": 15000,
        "handshakeTimeoutMs": 5000,
        "maxIncomingPayloadBytes": 65536,
        "maxBufferedBytes": 10485760,
        "shutdownGraceMs": 2000,
        "compression": true,
        "compressionThresholdBytes": 1024
    }
}
```

| Option | Description |
|---|---|
| `path` | HTTP upgrade path used by WebSocket clients. |
| `heartbeatIntervalMs` | Interval for checking connections with WebSocket ping/pong frames. |
| `handshakeTimeoutMs` | Time a new connection has to send a valid `hello` message. |
| `maxIncomingPayloadBytes` | Maximum size of a client protocol message. |
| `maxBufferedBytes` | Maximum queued outbound bytes before a slow connection is terminated. |
| `shutdownGraceMs` | Time allowed for connections to close normally during shutdown. |
| `compression` | Enables WebSocket `permessage-deflate`. |
| `compressionThresholdBytes` | Minimum message size at which compression is attempted. |

The values above are the defaults. A partial configuration may override individual values.

## Server API

### `createClientUpdates(registerUpdates, config)`

Creates the update layer. The required registration callback receives the `ClientUpdates` instance before the instance is returned. The configuration argument is optional.

### `registerTopic(name)`

Registers a topic that clients may subscribe to and the application may publish. Topic names must be unique. Registering a duplicate throws an error.

Topic names and client IDs contain 1 to 128 characters and must begin with a letter or number. Both accept letters, numbers, dots, underscores, colons, and hyphens; topic names additionally accept slashes.

### `registerClient(id, { name })`

Registers a known client and its optional display name. Registered clients appear in presence data immediately as offline. The ID identifies a browser installation for monitoring; it is not an authentication credential. Registering the same known client twice throws an error.

### `attach(httpServer)`

Attaches the WebSocket upgrade handler to the existing Node.js HTTP server and starts the heartbeat. The configured WebSocket path is handled by this layer; normal requests continue through the HTTP layer. An instance can be attached only once.

### `publish(topic, data)`

Publishes a JSON-serializable snapshot. The method serializes the update envelope once, increments the in-memory version of the topic, retains that serialized update, and sends it to every connection currently subscribed to the topic.

It returns:

```js
{
    topic: 'sap-data',
    version: 42,
    recipientCount: 8
}
```

Publishing to an unregistered topic, publishing data that cannot be serialized, or publishing after shutdown has begun throws an error. `recipientCount` counts connections, so two open tabs with the same client ID count as two recipients.

### `getClient(id)` and `getClients()`

Return read-only presence snapshots. `getClient()` returns `null` for an unknown ID. The returned values are detached from internal mutable state.

```js
{
    id: 'leitstand-01',
    name: 'Leitstand 1',
    registered: true,
    online: true,
    connectionCount: 2,
    topics: ['sap-data'],
    connectedAt: '2026-09-23T12:00:00.000Z',
    lastSeenAt: '2026-09-23T12:01:00.000Z',
    disconnectedAt: null
}
```

| Property | Description |
|---|---|
| `id` | Stable client ID reported during the handshake. |
| `name` | Registered display name, or `null` for unnamed clients. |
| `registered` | Whether the application registered the client explicitly. |
| `online` | Whether at least one connection is active. |
| `connectionCount` | Number of active tabs or other connections using this ID. |
| `topics` | Sorted union of topics subscribed to by those connections. |
| `connectedAt` | Start of the current or most recent online period, or `null` if never connected. |
| `lastSeenAt` | Time of the latest connection activity, or `null` if never connected. |
| `disconnectedAt` | Time the final connection closed, or `null` while online or never connected. |

Several tabs can use the same client ID. Presence is aggregated by ID: the client stays online until its final connection closes, and `topics` contains the union of the active connections' subscriptions.

### `getStats()`

Returns an operational snapshot. Topic subscribers count connections, while topic clients count distinct client IDs:

```js
{
    knownClients: 3,
    registeredClients: 1,
    onlineClients: 2,
    connections: 3,
    topics: {
        'sap-data': {
            subscribers: 3,
            clients: 2,
            version: 42,
            retained: true,
            publishedAt: '2026-09-23T12:00:00.000Z'
        }
    }
}
```

The layer does not expose an HTTP endpoint by itself.

### Presence events

`ClientUpdates` emits these events:

| Event | When it is emitted |
|---|---|
| `client:online` | The first connection for a client ID completes its handshake. |
| `client:offline` | The final connection for a client ID closes. |
| `client:subscriptions-changed` | The aggregated topics for a client ID change. |

Listen with the standard event API:

```js
clientUpdates.on('client:offline', (client) => {
    console.log(`${client.name} is offline`);
});
```

Listener failures are logged and isolated so they do not interrupt connection handling or other listeners.

### `close()`

Stops the heartbeat, closes connections with WebSocket close code `1001`, waits up to `shutdownGraceMs`, and terminates connections that remain open. It returns a promise, is idempotent, and is safe to await during application shutdown.

## Browser API

Import the browser helper from the static web root:

```js
import { createUpdateClient } from '/scripts/framework/updateClient.js';

const updates = createUpdateClient({
    clientId: 'leitstand-01'
});

const unsubscribe = updates.subscribe('sap-data', (data, metadata) => {
    renderSapData(data);
    console.log(`Received version ${metadata.version}`);
});

updates.onStatusChange((status) => {
    renderConnectionStatus(status);
});
```

`clientId` is optional. Without it, the helper creates a UUID and stores it in `localStorage`, so reconnects and later visits use the same identity. Explicit IDs are useful for fixed clients such as kiosk or control-room devices. Creating the helper immediately starts the connection.

Supported options are:

| Option | Default | Description |
|---|---|---|
| `clientId` | stored UUID | Explicit client identity. |
| `url` | current origin plus `path` | Endpoint override; relative and HTTP(S) URLs are resolved or converted to WS(S). |
| `path` | `/ws` | Same-origin WebSocket path when `url` is not set. |
| `storageKey` | `client-updates.client-id` | `localStorage` key for the generated client ID. |
| `reconnect.initialDelayMs` | `1000` | Initial reconnect delay. |
| `reconnect.maxDelayMs` | `30000` | Maximum reconnect delay. |
| `reconnect.factor` | `2` | Exponential delay factor. |
| `reconnect.jitter` | `0.2` | Random delay variation from `0` to `1`. |

The returned object exposes read-only `clientId` and `status` properties in addition to the methods below.

### `subscribe(topic, handler)`

Adds a local handler and subscribes to the topic after the handshake. The handler receives `(data, metadata)`, where metadata contains `topic`, `version`, and `publishedAt`. The method returns an idempotent unsubscribe function. Multiple handlers for the same topic share one server subscription. The helper automatically restores active subscriptions after reconnecting.

### `onStatusChange(handler)`

Registers a handler for connection-state changes and immediately calls it with the current status. Possible values are:

- `connecting`: the first connection attempt is running.
- `online`: the server accepted the handshake.
- `reconnecting`: a reconnect attempt is running.
- `offline`: the connection was lost.
- `closed`: `close()` intentionally stopped the client.

It returns an idempotent function that removes the status handler.

### `close()`

Closes the current connection and disables automatic reconnect. Repeated calls have no effect. Create a new update client to connect again.

## Wire Protocol

The protocol uses JSON text messages. A newly opened socket must send `hello` with a valid client ID within `handshakeTimeoutMs`:

```json
{ "type": "hello", "clientId": "leitstand-01" }
```

After `ready`, the client can manage topic subscriptions:

```json
{ "type": "subscribe", "topic": "sap-data" }
{ "type": "unsubscribe", "topic": "sap-data" }
```

Server message types are:

```json
{
    "type": "ready",
    "client": {
        "id": "leitstand-01",
        "name": "Leitstand 1",
        "registered": true
    },
    "heartbeatIntervalMs": 15000
}
```

```json
{ "type": "subscribed", "topic": "sap-data" }
```

```json
{ "type": "unsubscribed", "topic": "sap-data" }
```

```json
{ "type": "error", "code": "unknown_topic", "message": "Unknown topic \"sap-data\"." }
```

Published snapshots use this envelope:

```json
{
    "type": "update",
    "topic": "sap-data",
    "version": 42,
    "publishedAt": "2026-09-23T12:00:00.000Z",
    "data": {}
}
```

Subscribing sends the retained update immediately when the topic already has one. Topic versions begin again after every server restart because snapshots and counters are kept only in memory.

Malformed, binary, oversized, or out-of-order protocol messages close the connection. For protocol validation errors, the server first sends an `error` when possible. A well-formed request for an unknown topic receives an `error` message without closing the connection. Application code should use the browser helper instead of implementing these details repeatedly.

## Presence and Application Monitoring

The framework deliberately provides data rather than built-in monitoring routes or a dashboard. An application can expose only the information it needs:

```js
import { HttpResponse } from '#framework/http/response.js';

export default function monitoringRoutes(router, { clientUpdates }) {
    router.get('/clients', async () => {
        return HttpResponse.json({
            data: clientUpdates.getClients()
        });
    });

    router.get('/stats', async () => {
        return HttpResponse.json({
            data: clientUpdates.getStats()
        });
    });
}
```

This keeps access control, response shape, and UI decisions in the application. Registered clients survive disconnects as offline entries for the lifetime of the process. Dynamically discovered clients are also in-memory only and disappear on restart.

## Retention, Backpressure, and Compression

- Exactly the newest serialized update is retained per topic; older versions are discarded.
- A new or reconnected subscriber receives that latest update after subscribing.
- A connection whose outbound buffer would exceed `maxBufferedBytes` with the next snapshot is terminated instead of allowing memory use and latency to grow without limit.
- The browser helper reconnects and receives the newest retained state, so intermediate snapshots may be skipped intentionally.
- `permessage-deflate` is enabled by default for messages of at least `compressionThresholdBytes`. This substantially reduces repetitive JSON traffic but uses additional CPU and memory.
- Disable compression when payloads are already compressed or CPU time matters more than network bandwidth.

## Heartbeat and Connection Detection

The server sends WebSocket ping frames every `heartbeatIntervalMs`. A connection that no longer answers is terminated on a later heartbeat check. With the default 15-second interval, an unreachable client is normally detected within approximately 30 seconds.

Heartbeat traffic updates `lastSeenAt`. Normal WebSocket close events update the aggregated presence state immediately.

## Same-Origin and LAN Security

Browser upgrades must have the same origin as the HTTP server. This prevents another website opened in a browser from using the local update endpoint. Connections without an `Origin` header are accepted so non-browser clients can connect.

This layer does not provide authentication, authorization, TLS, or message-level encryption. Client IDs are self-declared monitoring identifiers and can be impersonated. Use the default setup only on a trusted local network. Deployments across untrusted networks need a reverse proxy with HTTPS and an application-specific authentication and authorization design.

## Shutdown Lifecycle

Stop scheduling before closing the transport:

```js
async function shutdown() {
    taskScheduler.stop();
    await clientUpdates.close();

    await new Promise((resolve, reject) => {
        httpServer.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}
```

The intended order is scheduler, WebSocket layer, then HTTP server. `Scheduler.stop()` prevents new executions but does not cancel a handler that is already running. Such a handler must finish before shutdown or handle the error raised if it calls `publish()` after `clientUpdates.close()` has begun.

## Scheduler and SAP Example

The scheduled task owns the application workflow. It reads and parses the export, builds the complete snapshot, and publishes only after processing succeeds:

```js
export default function registerTasks(scheduler, { clientUpdates }) {
    scheduler.register('refresh-sap-data', async () => {
        const exportFile = await readSapExport();
        const parsedData = await parseSapExport(exportFile);
        const snapshot = await prepareDashboardData(parsedData);

        clientUpdates.publish('sap-data', snapshot);
    }, {
        startAt: '00:00:00',
        stopAt: '23:59:59',
        intervalMs: 30000,
        runOnStart: true
    });
}
```

If reading or parsing fails, the task should log or handle the application error and leave the previously retained snapshot unchanged. The WebSocket layer has no knowledge of SAP files or their schema.

## WebSocket Conventions

- WebSocket transport implementation belongs under `framework/websocket/`.
- Domain-specific topics are registered by the application.
- Published values are complete, JSON-serializable snapshots.
- Application entry points such as routes and tasks may publish through the injected `clientUpdates` dependency; domain services remain transport-independent.
- Browser pages subscribe through the shared helper and render application-specific data themselves.
- Presence is operational information, not authentication state.
- Call `close()` before closing the HTTP server.
