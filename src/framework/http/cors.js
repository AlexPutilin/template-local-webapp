import config from '../../../app.config.json' with { type: 'json' };


export function getCorsHeaders() {
    if (!config?.enabled) return {};

    return {
        'Access-Control-Allow-Origin': config.origin ?? '*',
        'Access-Control-Allow-Methods': (config.methods ?? ['GET','OPTIONS']).join(', '),
        'Access-Control-Allow-Headers': (config.headers ?? ['Content-Type']).join(', ')
    };
}