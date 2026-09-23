# Local WebApp Framework – Architecture

## Purpose

This framework is a template for small local full-stack applications based on Node.js, for example dashboards, monitoring tools, data visualizations, CRUD applications, or kiosk systems.

The application runs as a single Node.js process. It is divided into three areas:

```text
Node Application
├─ Framework       → reusable technical foundation
├─ Application     → project-specific server logic
└─ Web             → browser UI and static files
```

The framework should remain stable whenever possible. Project-specific features belong primarily under `application/` and `web/`.

## Architecture Layers

### `framework/`

Contains reusable technical core features. The framework must not contain project-specific business logic.

Core features are organized by technical layer:

- [`framework/http/`](http.md) provides the HTTP server, routing, responses, static file handling, CORS, and the 404 fallback.
- `framework/websocket/` will provide WebSocket functionality.
- [`framework/scheduler/`](scheduler.md) registers and controls scheduled application tasks.
- [`framework/email/`](email.md) sends messages through the locally installed Outlook application.
- `framework/utils/` contains shared technical utilities.

### `application/`

Contains the logic of the current application:

- route modules
- scheduled tasks
- services
- repositories and data access
- application workflows

Routes translate HTTP input into application calls. Scheduled tasks provide time-based application entry points. Both should remain small and delegate business logic to services. Services must not depend on HTTP or scheduler-specific objects.

### `web/`

Contains browser code and static files:

- HTML pages
- JavaScript
- CSS
- images, icons, and other assets

The complete `web/` directory is the static web root. HTML pages should preferably be exposed through registered page routes.

### `app.js`

Acts as the composition root. It imports and connects the required framework and application components, registers routes, tasks or other core features, attaches optional lifecycle events, and starts the application.

Business logic does not belong in `app.js`.

## Project Structure

```text
project/
├─ bin/
├─ data/
├─ docs/
├─ app.config.json
├─ package.json
│
└─ src/
   ├─ app.js
   ├─ jsconfig.json
   │
   ├─ framework/
   │  ├─ email/
   │  ├─ http/
   │  ├─ websocket/
   │  ├─ scheduler/
   │  └─ utils/
   │
   ├─ application/
   │  ├─ routes/
   │  ├─ tasks/
   │  ├─ services/
   │  └─ repositories/
   │
   └─ web/
      ├─ pages/
      ├─ scripts/
      ├─ styles/
      └─ assets/
```

## Framework Conventions

- `framework/` contains reusable technical infrastructure only.
- `application/` contains project-specific server logic.
- `web/` contains browser code and static files only.
- `app.js` composes and starts the application.
- Routes stay small and delegate business logic to services.
- Tasks stay small and delegate business logic to services.
- Services remain independent of transport and scheduling layers.
- Route and task registration can be defined inline for small applications or moved into application modules when the application grows.
- New core features receive their own technical layer and their own documentation page.

## Core Layer and Feature Documentation

- [HTTP Layer](http.md)
- WebSocket Layer: planned
- [Scheduler Layer](scheduler.md)
- [Email Feature](email.md)
