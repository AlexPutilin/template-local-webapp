import path from 'node:path';
import { readFile } from 'node:fs/promises';


export class HttpResponse {
    constructor({
        statusCode = 200,
        contentType = 'text/plain; charset=utf-8',
        content = null,
        headers = {}
    } = {}) {
        this.statusCode = statusCode;
        this.contentType = contentType;
        this.content = content;
        this.headers = headers;
    }

    static text(content, {
        statusCode = 200, 
        headers = {}
    } = {}) {
        return new HttpResponse({
            statusCode, 
            contentType: 'text/plain; charset=utf-8', 
            content, 
            headers
        });
    }

    static html(content, {
        statusCode = 200,
        headers = {}
    } = {}) {
        return new HttpResponse({
            statusCode,
            contentType: 'text/html; charset=utf-8',
            content,
            headers
        });
    }

    static json({
        statusCode = 200,
        error = null,
        data = null,
        headers = {}
    } = {}) {
        return new HttpResponse({
            statusCode,
            contentType: 'application/json; charset=utf-8',
            content: JSON.stringify({
                error,
                data
            }),
            headers
        });
    }

    static empty({
        statusCode = 204,
        headers = {}
    } = {}) {
        return new HttpResponse({
            statusCode,
            contentType: null,
            content: null,
            headers
        });
    }

    static async file(filePath, {
        statusCode = 200,
        headers = {}
    } = {}) {
        const content = await readFile(filePath);

        return new HttpResponse({
            statusCode,
            contentType: getContentType(filePath),
            content,
            headers
        });
    }
}


export function sendResponse(res, response, extraHeaders = {}) {
    const headers = {
        ...extraHeaders,
        ...response.headers
    };

    if (response.contentType) {
        headers['Content-Type'] = response.contentType;
    }

    res.writeHead(response.statusCode, headers);
    res.end(response.content);
}


const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf'
};


function getContentType(filePath) {
    const extension = path.extname(filePath).toLowerCase();

    return contentTypes[extension] ?? 'application/octet-stream';
}