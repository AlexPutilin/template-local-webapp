import { Router } from '#framework/http/router.js';

const pages = {
    '/': 'index.html',
}


export default function pageRoutes(router) {
    router.pages(pages);
}