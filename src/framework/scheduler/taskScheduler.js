import { Scheduler } from '#framework/scheduler/scheduler.js';


export default function createTaskScheduler(registerTasks) {
    if (typeof registerTasks !== 'function') {
        throw new TypeError('createTaskScheduler requires a registration function.');
    }

    const taskScheduler = new Scheduler();
    registerTasks(taskScheduler);
    return taskScheduler;
}