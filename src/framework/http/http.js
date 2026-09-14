import { Router } from '#framework/http/router.js';
import http from 'node:http';


export default function createHttpServer(registerRoutes) {
    const router = new Router;

    registerRoutes(router);

    const httpServer = http.createServer((req, res) => {
            void router.handle(req, res);
        }
    );

    httpServer.on('clientError', (error, socket) => {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    return httpServer;
}