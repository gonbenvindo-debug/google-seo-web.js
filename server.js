'use strict';

const { timingSafeEqual } = require('crypto');
const http = require('http');
const { Client, LocalAuth, Services } = require('./');

const jsonRoutes = new Set([
    'POST /auth/login',
    'POST /auth/logout',
    'POST /browser/start',
    'POST /browser/open',
    'POST /browser/click',
    'POST /browser/type',
    'POST /browser/back',
    'POST /browser/reload',
    'POST /browser/stop',
]);

function hasValidKey(authorization, apiKey) {
    if (!apiKey) return true;
    const actual = Buffer.from(authorization || '');
    const expected = Buffer.from(`Bearer ${apiKey}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(request) {
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        const error = new Error('Content-Type must be application/json');
        error.status = 415;
        throw error;
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > 100_000) {
            const error = new Error('Request body is too large');
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function createApiServer(client, { apiKey } = {}) {
    let starting;
    const start = async (target) => {
        if (!client.pupBrowser && !starting) {
            starting = client.initialize(target).finally(() => { starting = null; });
        } else if (client.pupBrowser && target) {
            await client.open(target);
        }
        if (starting) await starting;
        return client.getStatus();
    };

    return http.createServer(async (request, response) => {
        const sendJson = (status, data) => {
            const body = JSON.stringify(data);
            response.writeHead(status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
            });
            response.end(body);
        };
        const sendPng = (data) => {
            response.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': data.length,
                'Cache-Control': 'no-store',
            });
            response.end(data);
        };

        try {
            if (!hasValidKey(request.headers.authorization, apiKey)) {
                return sendJson(401, { error: 'Unauthorized' });
            }
            const url = new URL(request.url, 'http://localhost');
            const route = `${request.method} ${url.pathname}`;
            const body = jsonRoutes.has(route) ? await readJson(request) : {};

            if (route === 'GET /health' || route === 'GET /auth/status') {
                return sendJson(200, await client.getStatus());
            }
            if (route === 'GET /services') return sendJson(200, Services);
            if (route === 'POST /auth/login' || route === 'POST /browser/start') {
                return sendJson(200, await start(body.target || body.service || 'search-console'));
            }
            if (route === 'POST /auth/logout') {
                await client.resetSession();
                return sendJson(200, await client.getStatus());
            }
            if (route === 'POST /browser/open') {
                if (!body.target) throw new TypeError('target is required');
                return sendJson(200, await start(body.target));
            }
            if (route === 'GET /browser/state') {
                return sendJson(200, await client.getState({
                    maxText: url.searchParams.has('maxText')
                        ? Number(url.searchParams.get('maxText'))
                        : undefined,
                    maxElements: url.searchParams.has('maxElements')
                        ? Number(url.searchParams.get('maxElements'))
                        : undefined,
                }));
            }
            if (route === 'POST /browser/click') {
                if (!body.id) throw new TypeError('id is required');
                return sendJson(200, await client.click(body.id));
            }
            if (route === 'POST /browser/type') {
                if (!body.id) throw new TypeError('id is required');
                return sendJson(200, await client.type(body.id, body.text, { submit: Boolean(body.submit) }));
            }
            if (route === 'POST /browser/back') return sendJson(200, await client.back());
            if (route === 'POST /browser/reload') return sendJson(200, await client.reload());
            if (route === 'GET /browser/screenshot') {
                return sendPng(await client.screenshot({ fullPage: url.searchParams.get('fullPage') === 'true' }));
            }
            if (route === 'POST /browser/stop') {
                await client.destroy();
                return sendJson(200, await client.getStatus());
            }
            return sendJson(404, { error: 'Not found' });
        } catch (error) {
            sendJson(
                error.status || (error instanceof TypeError || error instanceof SyntaxError ? 400 : 500),
                { error: error.message },
            );
        }
    });
}

async function main() {
    const port = Number(process.env.GOOGLE_SEO_API_PORT || 3100);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('GOOGLE_SEO_API_PORT must be an integer between 1 and 65535');
    }
    const client = new Client({ authStrategy: new LocalAuth() });
    const server = createApiServer(client, { apiKey: process.env.GOOGLE_SEO_API_KEY });
    server.listen(port, '127.0.0.1', () => {
        console.log(`Google SEO API ready at http://127.0.0.1:${port}`);
        console.log('Use POST /auth/login with JSON {} to open Search Console.');
    });
    const close = () => server.close(() => client.destroy());
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}

if (require.main === module) main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

module.exports = { createApiServer };
