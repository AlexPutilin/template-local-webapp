# Local Web App Framework – Architecture

## Purpose

This template is intended for small local full-stack applications based on Node.js, such as dashboards, monitoring tools, data visualizations, CRUD applications, or kiosk systems.

The application runs as a single Node.js process and provides both the HTTP API and the browser-based user interface.

Core concept:

```text
Node Application
├─ Framework       → technical foundation
├─ Application     → project-specific logic
└─ Web             → browser UI
```

The framework should remain stable whenever possible. New features should mainly be added under `application/` and `web/`.

---

## 1. Responsibilities

### `framework/`

Contains reusable technical boilerplate code.

Typical responsibilities:

- create the HTTP server
- route incoming requests
- parse URLs and query parameters
- create and send HTTP responses
- serve static files from `web/`
- handle CORS
- provide the 404 fallback
- provide shared technical utilities

The framework must not contain project-specific business logic.

### `application/`

Contains the actual logic of the current project.

Typical contents:

- HTTP route registration
- services
- repositories / data access
- application workflows

Routes handle HTTP input, call services when required, and always return an `HttpResponse`.

### `web/`

Contains files that run in the browser.

Typical contents:

- HTML pages
- JavaScript
- CSS
- images, icons, and other assets

The complete `web/` directory acts as the static web root. Files can be requested according to their directory structure.

Example:

```text
src/web/scripts/foo.js
→ /scripts/foo.js
```

HTML pages under `web/pages/` should preferably be exposed through registered page routes.

### `app.js`

Acts as the composition root of the application.

`app.js`:

- imports the required application components
- creates the HTTP server
- registers HTTP routes
- optionally registers server lifecycle events
- starts the server

Business logic does not belong in `app.js`.

---

## 2. Example Project Structure

```text
project/
├─ bin/
├─ data/
├─ app.config.json
├─ package.json
│
└─ src/
   ├─ app.js
   ├─ jsconfig.json
   │
   ├─ framework/
   │  ├─ http/
   │  │  ├─ http.js
   │  │  ├─ router.js
   │  │  ├─ response.js
   │  │  ├─ static.js
   │  │  └─ cors.js
   │  │
   │  └─ utils/
   │     └─ path.js
   │
   ├─ application/
   │  ├─ routes/
   │  │  ├─ routes.js
   │  │  ├─ pages.js
   │  │  ├─ users.js
   │  │  └─ machines.js
   │  │
   │  ├─ services/
   │  │  └─ machineService.js
   │  │
   │  └─ repositories/
   │     └─ machineRepository.js
   │
   └─ web/
      ├─ jsconfig.json
      ├─ index.html
      ├─ main.js
      ├─ styles.css
      │
      ├─ pages/
      │  ├─ admin.html
      │  └─ 404.html
      │
      ├─ scripts/
      │  ├─ modules/
      │  ├─ services/
      │  └─ components/
      │
      ├─ styles/
      │  ├─ tokens.css
      │  └─ components/
      │
      └─ assets/
```

---

## 3. `app.js` and HTTP Route Registration

The HTTP server is created with `createHttpServer()`. It receives a function that registers the project-specific routes.

### Variant A – Central `routes.js`

Recommended when the project contains multiple route modules.

`application/routes/routes.js`:

```js
import pageRoutes from './pages.js';
import userRoutes from './users.js';
import machineRoutes from './machines.js';

export default function registerRoutes(router) {
    router.register('/', pageRoutes);
    router.register('/api/users', userRoutes);
    router.register('/api/machines', machineRoutes);
}
```

`app.js`:

```js
import config from '../config.json' with { type: 'json' };
import createHttpServer from '#framework/http/http.js';
import registerRoutes from '#application/routes/routes.js';

const httpServer = createHttpServer(registerRoutes);

httpServer.on('error', (error) => {
    console.error('HTTP server failed:', error);
    process.exit(1);
});

httpServer.on('listening', () => {
    console.log('HTTP server is listening');
});

httpServer.listen(
    config.http.port,
    config.http.host
);
```

### Variant B – Register Routes Directly in `app.js`

For very small projects, routes can be registered directly when creating the server.

```js
import config from '../config.json' with { type: 'json' };
import createHttpServer from '#framework/http/http.js';
import pageRoutes from '#application/routes/pages.js';
import userRoutes from '#application/routes/users.js';
import machineRoutes from '#application/routes/machines.js';

const httpServer = createHttpServer((router) => {
    router.register('/', pageRoutes);
    router.register('/api/users', userRoutes);
    router.register('/api/machines', machineRoutes);
});

httpServer.listen(
    config.http.port,
    config.http.host
);
```

Both variants use the same framework. A central `routes.js` keeps `app.js` cleaner in larger projects.

---

## 4. Creating New API Endpoints

A route module registers its endpoints relative to the prefix defined by `router.register()`.

Example:

```js
import { HttpResponse } from '#framework/http/response.js';

export default function userRoutes(router) {
    router.get('/', async () => {
        return HttpResponse.json({
            data: [
                { id: 1, name: 'Alex' }
            ]
        });
    });

    router.get('/:id', async ({ params }) => {
        return HttpResponse.json({
            data: {
                id: params.id
            }
        });
    });

    router.post('/', async () => {
        return HttpResponse.json({
            statusCode: 201,
            data: {
                created: true
            }
        });
    });
}
```

When registered with:

```js
router.register('/api/users', userRoutes);
```

the following endpoints are created:

```text
GET  /api/users
GET  /api/users/:id
POST /api/users
```

### API-Endpoint Workflow

```text
1. Create a route module under application/routes/
2. Import the required service
3. Define endpoints with router.get(), router.post(), etc.
4. Return an HttpResponse
5. Register the route module once
```

Route handlers are written consistently as `async` functions and always return an `HttpResponse`.

Example using a service:

```js
router.get('/', async () => {
    try {
        const machines = await machineService.getAll();
        return HttpResponse.json({
            data: machines
        });
    } catch {
        return HttpResponse.json({
            statusCode: 400,
            error: 'Something went wrong.'
        });
    }
});
```

---

## 5. Creating New Frontend Pages

HTML pages are stored under:

```text
src/web/pages/
```

Example:

```text
src/web/pages/admin.html
```

Related browser files can be organized freely under `web/`:

```text
src/web/scripts/admin.js
src/web/styles/admin.css
src/web/assets/logo.svg
```

They are automatically available as:

```text
/scripts/admin.js
/styles/admin.css
/assets/logo.svg
```

### Page Routes

`application/routes/pages.js`:

```js
const pages = {
    '/': 'pages/index.html',
    '/admin': 'pages/admin.html',
    '/settings': 'pages/settings.html'
};

export default function pageRoutes(router) {
    router.pages(pages);
}
```

Add a new page by extending the object:

```js
const pages = {
    '/': 'pages/index.html',
    '/admin': 'pages/admin.html',
    '/settings': 'pages/settings.html',
    '/monitoring': 'pages/monitoring.html'
};
```

### Page Workflow

```text
1. Create the HTML file under web/pages/
2. Add required scripts, styles, or assets under web/
3. Add the URL → HTML mapping to pages.js
4. Done
```

Optional you can store a default 404 page at:

```text
src/web/pages/404.html
```

If neither a registered route nor a static file is found, the router automatically returns this page with HTTP status `404`.

---

## Architecture Rules

- `framework/` contains no project-specific logic.
- `application/` contains the logic of the current application.
- `web/` contains browser code and static files only.
- Routes should contain as little logic as possible and delegate work to services.
- Services must not depend on HTTP.
- Route handlers always return an `HttpResponse`.
- The router handles URL parsing, static fallback, and 404 responses.
- New directories under `web/` do not require framework changes.
- `app.js` stays small and is only responsible for composing and starting the application.
