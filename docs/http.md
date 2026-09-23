# HTTP Layer

## Purpose

The HTTP layer under `src/framework/http/` provides the reusable HTTP foundation of the framework. Project-specific endpoints are defined under `src/application/routes/`.

```text
src/framework/http/
├─ http.js       → creates the HTTP server
├─ router.js     → processes requests and resolves routes
├─ response.js   → creates and sends HTTP responses
├─ static.js     → resolves static files from web/
└─ cors.js       → defines CORS headers
```

## Request Flow

```text
HTTP request
→ http.js
→ router.js
→ registered application route
→ HttpResponse
→ response.js
```

If no application route matches, the router checks for a static file for `GET` and `HEAD` requests. If no resource is found, it returns the 404 fallback.

## Route Registration Convention

`createHttpServer()` receives one registration function. The framework creates the `Router` internally and passes it to that function.

For projects with multiple route modules, route registration should be collected in `src/application/routes/routes.js`:

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

`src/app.js` uses that registration function when creating the server:

```js
import config from '../app.config.json' with { type: 'json' };
import createHttpServer from '#framework/http/http.js';
import registerRoutes from '#application/routes/routes.js';

const httpServer = createHttpServer(registerRoutes);

httpServer.listen(
    config.http.port,
    config.http.host
);
```

For a very small application, the same registration function may be defined inline in `app.js`:

```js
const httpServer = createHttpServer((router) => {
    router.register('/', pageRoutes);
    router.register('/api/users', userRoutes);
});
```

Both forms follow the same convention. The central `routes.js` is the preferred organization when several route modules exist.

## Route Modules

A route module registers endpoints relative to the prefix passed to `router.register()`:

```js
import { HttpResponse } from '#framework/http/response.js';

export default function userRoutes(router) {
    router.get('/', async () => {
        return HttpResponse.json({
            data: []
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

Registered with:

```js
router.register('/api/users', userRoutes);
```

this creates:

```text
GET  /api/users
GET  /api/users/:id
POST /api/users
```

Route handlers are written as `async` functions and always return an `HttpResponse`. They should validate HTTP input and delegate application logic to services.

## Page Routes and Static Files

HTML pages should be registered through a page route module:

```js
export default function pageRoutes(router) {
    router.pages({
        '/': 'index.html',
        '/admin': 'pages/admin.html'
    });
}
```

Other files under `src/web/` are available according to their directory structure:

```text
src/web/scripts/admin.js  → /scripts/admin.js
src/web/styles/admin.css  → /styles/admin.css
src/web/assets/logo.svg   → /assets/logo.svg
```

An optional fallback page can be stored at:

```text
src/web/pages/404.html
```

---

## HttpResponse

All route handlers must return an `HttpResponse`.

The framework provides several response types depending on the use case:

```js
HttpResponse.json(...)
HttpResponse.html(...)
HttpResponse.text(...)
HttpResponse.empty(...)
HttpResponse.file(...)
```

Example JSON response:

```js
return HttpResponse.json({
    data: users
});
```

Example error response:

```js
return HttpResponse.json({
    statusCode: 400,
    error: 'Something went wrong.'
});
```

Most response types support additional options such as:

```js
{
    statusCode: 200,
    headers: {}
}
```

---

## Request Context

Every route handler receives a request context.

```js
router.get('/', async ({
    request,
    method,
    url,
    pathname,
    search,
    searchParams,
    params
}) => {
    return HttpResponse.empty();
});
```

Property overview:

| Property | Description |
|-----------|-------------|
| request | Node.js request object |
| method | HTTP method |
| url | URL object |
| pathname | Requested path |
| search | Query string |
| searchParams | URLSearchParams |
| params | Route parameters |

---

## HTTP Conventions

- HTTP implementation belongs under `framework/http/`.
- Project-specific endpoints belong under `application/routes/`.
- Route modules are registered once with a path prefix.
- Route paths inside a module are relative to that prefix.
- Route handlers always return an `HttpResponse`.
- Routes stay small and delegate business logic to services.
- Services do not depend on HTTP request or response objects.
- CORS, static file handling, response delivery, and 404 handling remain centralized in the HTTP layer.
