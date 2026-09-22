# Scheduler Layer

## Purpose

The scheduler layer under `src/framework/scheduler/` provides reusable time-based task execution. Project-specific tasks are registered by the application.

```text
src/framework/scheduler/
├─ taskScheduler.js  → creates the scheduler and registers application tasks
└─ scheduler.js    → stores, schedules, starts, and stops tasks
```

A task is an asynchronous function. It can run once per day or repeatedly within a daily time window.

## Task Flow

```text
Application startup
→ createTaskScheduler(registerTasks)
→ Scheduler instance
→ registered application task
→ task handler
```

Calling `start()` activates all registered schedules. Calling `stop()` clears their pending timers.

## Task Registration Convention

`createTaskScheduler()` receives one registration function. The framework creates the `Scheduler` internally and passes it to that function.

For applications with multiple tasks, collect the registration in `src/application/tasks/index.js`:

```js
import cleanupTask from './cleanupTask.js';
import reportTask from './reportTask.js';

export default function registerTasks(taskScheduler) {
    taskScheduler.register('cleanup', cleanupTask, {
        startAt: '18:00:00'
    });

    taskScheduler.register('report', reportTask, {
        startAt: '08:00:00',
        stopAt: '17:00:00',
        intervalMs: 300000,
        runOnStart: true
    });
}
```

A task module contains the project-specific entry point:

```js
export default async function cleanupTask() {
    // Delegate application logic to services here
}
```

Register and start the tasks in `src/app.js`:

```js
import registerTasks from '#application/tasks/index.js';
import createTaskScheduler from '#framework/scheduler/taskScheduler.js';

const taskScheduler = createTaskScheduler(registerTasks);

taskScheduler.start();
```

For a small application, tasks can be registered inline with arrow functions:

```js
import createTaskScheduler from '#framework/scheduler/taskScheduler.js';

const taskScheduler = createTaskScheduler((taskScheduler) => {
    taskScheduler.register('startup-check', async () => {
        console.log('Startup check executed.');
    }, {
        startAt: '08:00:00',
        runOnStart: true
    });

    taskScheduler.register('working-hours-check', async () => {
        console.log('Working hours check executed.');
    }, {
        startAt: '08:00:00',
        stopAt: '17:00:00',
        intervalMs: 60000
    });
});

taskScheduler.start();
```

Both forms use the same registration convention. The separate `application/tasks/` module is preferred when several tasks exist.

## Scheduler Methods

### `register(name, handler, options)`

Registers a task and returns the `Scheduler` instance.

Parameters:

| Parameter | Type | Required | Description |
|---|---|---:|---|
| `name` | `string` | yes | Unique task name. A duplicate name causes an error. |
| `handler` | `function` | yes | Function executed by the scheduler. Async functions are supported. |
| `options.startAt` | `string` | yes | Daily start time in `HH:MM:SS` format. |
| `options.stopAt` | `string \| null` | for intervals | Daily end time in `HH:MM:SS` format. Required when `intervalMs` is set. |
| `options.intervalMs` | `number \| null` | no | Repetition delay in milliseconds. Must be greater than zero. Without it, the task runs once per day at `startAt`. |
| `options.runOnStart` | `boolean` | no | Executes the task when the manager starts. Default: `false`. |

A task that is still running is not started again in parallel.

### `start()`

Starts all registered schedules and returns the `Scheduler` instance. Calling it again while the scheduler is active has no effect.

### `stop()`

Stops scheduling, clears all pending task timers, and returns the `Scheduler` instance. A handler that is already executing is not cancelled.

## Scheduling Behavior

- Without `intervalMs`, a task runs daily at `startAt`.
- With `intervalMs`, a task repeats between `startAt` and `stopAt`.
- A time window may cross midnight.
- `runOnStart` is independent of the configured daily schedule.
- Task errors are logged and do not stop the remaining schedules.
- Execution history is not persisted.

## Scheduler Conventions

- Scheduler implementation belongs under `framework/scheduler/`.
- Project-specific tasks belong under `application/tasks/`.
- Use `createTaskScheduler(registerTasks)` as the application entry point.
- Task handlers should be asynchronous and delegate business logic to services.
- Use unique task names.
- Use the local system time in `HH:MM:SS` format.
- Call `stop()` during application shutdown to clear pending timers.
