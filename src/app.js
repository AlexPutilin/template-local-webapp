import config from '../app.config.json' with { type: 'json' };
import createHttpServer from '#framework/http/http.js';
import pageRoutes from '#application/routes/pages.js';


const httpServer = createHttpServer(router => {
    router.register('/', pageRoutes);
});


httpServer.on('error', (err) => {
    console.error('HTTP-Server failed to start:', err);
    process.exit(1);
});


httpServer.on('listening', () => {
    console.log(`HTTP-Server is listening on http://${config.http.host}:${config.http.port}`);
});


httpServer.listen(config.http.port, config.http.host);