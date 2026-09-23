import config from '../app.config.json' with { type: 'json' };
import createHttpServer from '#framework/http/http.js';
import createTaskScheduler from '#framework/scheduler/taskScheduler.js';
import createClientUpdates from '#framework/websocket/index.js';
import pageRoutes from '#application/routes/pages.js';


const clientUpdates = createClientUpdates((updates) => {
    // Register your topics and known clients here
}, config.websocket);


const taskScheduler = createTaskScheduler((scheduler) => {
    // Register your tasks here
});


const httpServer = createHttpServer((router) => {
    router.register('/', pageRoutes);
});


clientUpdates.attach(httpServer);


httpServer.on('error', (err) => {
    console.error('HTTP-Server failed to start:', err);
    taskScheduler.stop();
    void clientUpdates.close()
        .catch((error) => {
            console.error('Error occurred while closing client updates:', error);
        })
        .finally(() => process.exit(1));
});


httpServer.on('listening', () => {
    console.log(`HTTP-Server is listening`);
    taskScheduler.start();
});


let shuttingDown = false;


async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Received ${signal}. Stopping application.`);
    taskScheduler.stop();

    try {
        await clientUpdates.close();
        await closeHttpServer(httpServer);
        process.exit(0);
    } catch (error) {
        console.error('Error occurred while stopping the application:', error);
        process.exit(1);
    }
}


process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));


httpServer.listen(config.http.port, config.http.host);


function closeHttpServer(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) return reject(error);
            resolve();
        });
    });
}
