export class Scheduler {
    constructor() {
        this.tasks = new Map();
        this.started = false;
    }

    register(name, handler, {
        startAt,
        stopAt = null,
        intervalMs = null,
        runOnStart = false
    } = {}) {
        if (this.tasks.has(name)) {
            throw new Error(`Task with name "${name}" is already registered.`);
        }

        if (!handler || typeof handler !== 'function') {
            throw new TypeError(`Handler for task "${name}" must be a function.`);
        }

        validateTime(startAt, 'startAt');

        if (stopAt !== null) {
            validateTime(stopAt, 'stopAt');
        }

        if (intervalMs !== null && (typeof intervalMs !== 'number' || intervalMs <= 0)) {
            throw new TypeError(`intervalMs for task "${name}" must be a positive number.`);
        }

        if (intervalMs !== null && stopAt === null) {
            throw new Error(`Task "${name}" has an interval but no stopAt time.`);
        }

        this.tasks.set(name, {
            handler,
            startAt,
            stopAt,
            intervalMs,
            runOnStart,
            running: false,
            intervalActive: false,
            timers: new Set()
        });

        return this;
    }

    start() {
        if (this.started) return this;
        this.started = true;
        for (const task of this.tasks.values()) {
            if (task.runOnStart) {
                this.runTask(task);
            }
            if (task.intervalMs === null) {
                this.scheduleDailyTask(task);
            } else {
                this.scheduleIntervalTask(task);
            }
        }
        return this;
    }

    stop() {
        for (const task of this.tasks.values()) {
            task.intervalActive = false;
            for (const timer of task.timers) {
                clearTimeout(timer);
            }
            task.timers.clear();
        }
        this.started = false;
        return this;
    }

    scheduleDailyTask(task) {
        const delay = getDelayUntil(task.startAt);
        this.setTaskTimeout(task, async () => {
            await this.runTask(task);
            if (this.started) {
                this.scheduleDailyTask(task);
            }
        }, delay);
    }

    scheduleIntervalTask(task) {
        if (isWithinWindow(new Date(), task.startAt, task.stopAt)) {
            this.startInterval(task, !task.runOnStart);
        }
        this.scheduleIntervalStart(task);
        this.scheduleIntervalStop(task);
    }

    scheduleIntervalStart(task) {
        const delay = getDelayUntil(task.startAt);
        this.setTaskTimeout(task, async () => {
            this.startInterval(task, true);
            if (this.started) {
                this.scheduleIntervalStart(task);
            }
        }, delay);
    }

    scheduleIntervalStop(task) {
        const delay = getDelayUntil(task.stopAt);
        this.setTaskTimeout(task, async () => {
            task.intervalActive = false;
            if (this.started) {
                this.scheduleIntervalStop(task);
            }
        }, delay);
    }

    startInterval(task, runImmediately) {
        if (task.intervalActive) return;
        task.intervalActive = true;
        const run = async () => {
            if (!this.started || !task.intervalActive) return;
            await this.runTask(task);
            if (this.started && task.intervalActive) {
                this.setTaskTimeout(task, run, task.intervalMs);
            }
        };
        if (runImmediately) {
            void run();
        } else {
            this.setTaskTimeout(task, run, task.intervalMs);
        }
    }

    async runTask(task) {
        if (task.running) {
            console.warn(`Task "${task.name}" skipped because it is already running.`);
            return;
        }
        task.running = true;
        try {
            await task.handler();
        } catch (error) {
            console.error(`Task "${task.name}" failed with error:`, error);
        } finally {
            task.running = false;
        }
    }

    setTaskTimeout(task, callback, delay) {
        const timer = setTimeout(() => {
            task.timers.delete(timer);
            void callback();
        }, delay);
        task.timers.add(timer);
        return timer;
    }
}


function validateTime(value, optionName) {
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) {
        throw new TypeError(`Invalid time format for option "${optionName}". Expected "HH:MM:SS".`);
    }
}


function getDelayUntil(time) {
    const now = new Date();
    const next = createDateAtTime(now, time);
    if (next <= now) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
}


function isWithinWindow(now, startAt, stopAt) {
    const start = createDateAtTime(now, startAt);
    const stop = createDateAtTime(now, stopAt);
    if (start < stop) {
        return now >= start && now < stop;
    }
    return now >= start || now <= stop;
}


function createDateAtTime(baseDate, time) {
    const [hours, minutes, seconds] = time.split(':').map(Number);
    const date = new Date(baseDate);
    date.setHours(hours, minutes, seconds, 0);
    return date;
}