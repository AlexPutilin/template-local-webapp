import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..', '..');


export function rootPath(...segments) {
    return join(PROJECT_ROOT, ...segments);
}


export function dataPath(...segments) {
    return join(PROJECT_ROOT, 'data', ...segments);
}


export function appPath(...segments) {
    return join(PROJECT_ROOT, 'src', ...segments);
}


export function webPath(...segments) {
    return join(PROJECT_ROOT, '/src/web', ...segments);
}


export { PROJECT_ROOT };