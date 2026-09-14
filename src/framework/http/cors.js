import config from '../../../app.config.json' with { type: 'json' };


export function getCorsHeaders() {
    const cors = config.http.cors;
    if (!cors?.enabled) return {};

    return {
        'Access-Control-Allow-Origin': cors.origin ?? '*',
        'Access-Control-Allow-Methods': (cors.methods ?? ['GET','OPTIONS']).join(', '),
        'Access-Control-Allow-Headers': (cors.headers ?? ['Content-Type']).join(', ')
    };
}