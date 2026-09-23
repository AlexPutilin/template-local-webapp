import config from '../app.config.json' with { type: 'json' };
import createHttpServer from '#framework/http/http.js';
import createTaskScheduler from '#framework/scheduler/taskScheduler.js';
import userRoutes from '#application/routes/userRoutes.js';
import pageRoutes from '#application/routes/pageRoutes.js';


const taskScheduler = createTaskScheduler((scheduler) => {
    // Register your tasks here
});


const httpServer = createHttpServer((router) => {
    router.register('/', pageRoutes);
    router.register('/api/users', userRoutes);
});


httpServer.on('error', (err) => {
    console.error('HTTP-Server failed to start:', err);
    taskScheduler.stop();
    process.exit(1);
});


httpServer.on('listening', () => {
    console.log(`HTTP-Server is listening`);
    taskScheduler.start();
});


function shutdown(signal) {
    console.log(`Received ${signal}. Stopping application.`);
    taskScheduler.stop();
    httpServer.close((error) => {
        if (error) {
            console.error('Error occurred while closing HTTP-Server:', error);
            process.exit(1);
        }
        process.exit(0);
    });
}


process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));


httpServer.listen(config.http.port, config.http.host);
