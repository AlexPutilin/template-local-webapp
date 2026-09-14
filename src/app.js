import createHttpServer from '#framework/http/http.js';
import config from '../app.config.json' with { type: 'json' };


const httpServer = createHttpServer();


httpServer.on('error', (err) => {
    console.error('HTTP-Server failed to start:', err);
    process.exit(1);
});


httpServer.on('listening', () => {
    console.log(`HTTP-Server is listening`);
});


httpServer.listen(config.http.port, config.http.host);