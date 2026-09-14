import { getCorsHeaders } from '#framework/http/cors.js';
import { HttpResponse, sendResponse } from '#framework/http/response.js';
import { serveStatic } from '#framework/http/static.js';
import { webPath } from '#framework/utils/path.js';


export class Router {
    constructor() {
        this.routes = [];
    }

    get(path, handler) {
        return this.add('GET', path, handler);
    }

    post(path, handler) {
        return this.add('POST', path, handler);
    }

    put(path, handler) {
        return this.add('PUT', path, handler);
    }

    patch(path, handler) {
        return this.add('PATCH', path, handler);
    }

    delete(path, handler) {
        return this.add('DELETE', path, handler);
    }

    add(method, routePath, handler) {
        this.routes.push({
            method,
            path: normalizePath(routePath),
            handler
        });
        return this;
    }

    register(prefix, registerRoutes) {
        const router = new RouteGroup(this, normalizePath(prefix));
        registerRoutes(router);
        return this;
    }

    page(routePath, filePath) {
        this.get(routePath, async () => {
                return HttpResponse.file(webPath(filePath));
            }
        );
        return this;
    }

    pages(pages) {
        for (const [routePath, filePath] of Object.entries(pages)) {
            this.page(routePath, filePath);
        }
        return this;
    }

    async handle(req, res) {
        try {
            const corsHeaders = getCorsHeaders();
            const url = new URL(req.url ?? '/', 'http://localhost');
            const pathname = normalizePath(url.pathname);
            const match = this.findRoute(req.method, pathname);
            
            if (match) {
                const response = await match.route.handler({
                    request: req,
                    method: req.method,
                    url,
                    pathname,
                    search: url.search,
                    searchParams: url.searchParams,
                    params: match.params
                });
                this.validateResponse(response);
                return sendResponse(res, response);
            }

            if (req.method === 'GET' || req.method === 'HEAD') {
                const response = await serveStatic(pathname);
                if (response) return sendResponse(res, response);
            }
            return sendResponse(res, await this.notFound());
        } catch (error) {
            console.error('HTTP request failed:', error);
            if (res.headersSent) return res.destroy();
            return sendResponse(res, HttpResponse.text('500 Internal Server Error', { statusCode: 500 }));
        }
    }

    findRoute(method, pathname) {
        for (const route of this.routes) {
            if (route.method !== method) continue;
            const params = matchPath(route.path,pathname);
            if (params !== null) return {route, params};
        }
        return null;
    }

    async notFound() {
        try {
            return await HttpResponse.file(webPath('pages', '404.html'), { statusCode: 404 });
        } catch {
            return HttpResponse.text('404 Not Found', { statusCode: 404 });
        }
    }

    validateResponse(response) {
        if (!(response instanceof HttpResponse)) {
            throw new TypeError('Route handler must return an HttpResponse.');
        }
    }
}


class RouteGroup {
    constructor(router, prefix) {
        this.router = router;
        this.prefix = prefix;
    }

    get(path, handler) {
        this.router.get(joinPaths(this.prefix, path), handler);
        return this;
    }

    post(path, handler) {
        this.router.post(joinPaths(this.prefix,path), handler);
        return this;
    }

    put(path, handler) {
        this.router.put(joinPaths(this.prefix, path), handler);
        return this;
    }

    patch(path, handler) {
        this.router.patch(joinPaths(this.prefix, path), handler);
        return this;
    }

    delete(path, handler) {
        this.router.delete(joinPaths(this.prefix, path), handler);
        return this;
    }

    pages(pages) {
        for (const [routePath, filePath] of Object.entries(pages)) {
            this.router.page(joinPaths(this.prefix, routePath), filePath);
        }
        return this;
    }
}


function normalizePath(value) {
    if (!value || value === '/') return '/';
    let result = value;
    if (!result.startsWith('/')) result = `/${result}`;
    return result.replace(/\/+$/, '') || '/';
}


function joinPaths(prefix, routePath) {
    if (prefix === '/') return normalizePath(routePath);
    if (routePath === '/') return normalizePath(prefix);
    return normalizePath(`${prefix}/${routePath}`);
}


function matchPath(pattern, pathname) {
    const patternParts = splitPath(pattern);
    const pathnameParts = splitPath(pathname);
    const params = {};
    if (patternParts.length !== pathnameParts.length) return null;

    for (let i = 0; i < patternParts.length; i++) {
        const patternPart = patternParts[i];
        const pathnamePart = pathnameParts[i];
        if (patternPart.startsWith(':')) {
            try {
                params[patternPart.slice(1)] = decodeURIComponent(pathnamePart);
            } catch {
                return null;
            }
            continue;
        }
        if (patternPart !== pathnamePart) return null;
    }
    return params;
}


function splitPath(value) {
    return value.split('/').filter(Boolean);
}