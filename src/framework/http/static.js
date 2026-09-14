import { HttpResponse } from '#framework/http/response.js';
import { webPath } from '#framework/utils/path.js';
import path from 'node:path';


const WEB_ROOT = webPath();


export async function serveStatic(pathname) {
    let relativePath;

    try {
        relativePath = decodeURIComponent(pathname);
    } catch {
        return null;
    }

    relativePath = relativePath.replace(/^[/\\]+/, '');
    const filePath = path.resolve(WEB_ROOT,relativePath);

    if (!isInsideWebRoot(filePath)) return null;

    try {
        return await HttpResponse.file(filePath);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') return null;
        throw error;
    }
}


function isInsideWebRoot(filePath) {
    const relative = path.relative(WEB_ROOT, filePath);
    return (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}