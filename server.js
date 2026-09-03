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
    'POST /search-console/control',
    'POST /search-console/filter',
    'POST /search-console/sitemaps',
    'POST /search-console/url-inspection',
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

function booleanParam(parameters, name, fallback = false) {
    if (!parameters.has(name)) return fallback;
    const value = parameters.get(name);
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new TypeError(`${name} must be true or false`);
}

function integerParam(parameters, name, fallback) {
    if (!parameters.has(name)) return fallback;
    const value = Number(parameters.get(name));
    if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer`);
    return value;
}

function toCsv(report, tableIndex = 0) {
    const table = report.tables?.[tableIndex];
    if (!table) throw new TypeError(`Report has no table at index ${tableIndex}`);
    const width = Math.max(table.headers.length, ...table.rows.map((row) => row.length));
    const headers = table.headers.length
        ? table.headers
        : Array.from({ length: width }, (_, index) => `column_${index + 1}`);
    const escape = (value) => {
        const text = String(value ?? '');
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [headers, ...table.rows]
        .map((row) => Array.from({ length: width }, (_, index) => escape(row[index])).join(','))
        .join('\r\n');
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
        const sendCsv = (data, filename) => {
            const body = Buffer.from(`\uFEFF${data}`, 'utf8');
            response.writeHead(200, {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Length': body.length,
                'Content-Disposition': `attachment; filename="${filename.replace(/[^a-z0-9._-]/gi, '-')}"`,
                'Cache-Control': 'no-store',
            });
            response.end(body);
        };

        try {
            if (!hasValidKey(request.headers.authorization, apiKey)) {
                return sendJson(401, { error: 'Unauthorized' });
            }
            const url = new URL(request.url, 'http://localhost');
            const route = `${request.method} ${url.pathname}`;
            const body = jsonRoutes.has(route) ? await readJson(request) : {};
            const ensureSearchConsole = async () => {
                if (!client.pupBrowser) await start('search-console');
            };
            const reportOptions = () => ({
                report: url.searchParams.get('report') || 'overview',
                path: url.searchParams.get('path') || undefined,
                property: url.searchParams.get('property') || undefined,
                tab: url.searchParams.get('tab') || undefined,
                allPages: booleanParam(url.searchParams, 'allPages'),
                maxPages: integerParam(url.searchParams, 'maxPages', 50),
            });
            const performanceOptions = () => ({
                property: url.searchParams.get('property') || undefined,
                dimension: url.searchParams.get('dimension') || 'queries',
                period: url.searchParams.get('period') || undefined,
                startDate: url.searchParams.get('startDate') || undefined,
                endDate: url.searchParams.get('endDate') || undefined,
                filters: Object.fromEntries(['query', 'page', 'country', 'device', 'appearance']
                    .filter((name) => url.searchParams.has(name))
                    .map((name) => [name, url.searchParams.get(name)])),
                operators: {
                    query: url.searchParams.get('queryOperator') || undefined,
                    page: url.searchParams.get('pageOperator') || undefined,
                },
                allMetrics: booleanParam(url.searchParams, 'allMetrics', true),
                allPages: booleanParam(url.searchParams, 'allPages'),
                maxPages: integerParam(url.searchParams, 'maxPages', 50),
            });
            const indexingPagesOptions = () => ({
                property: url.searchParams.get('property') || undefined,
                status: url.searchParams.get('status') || 'all',
                reason: url.searchParams.get('reason') || undefined,
                urlContains: url.searchParams.get('urlContains') || undefined,
                language: url.searchParams.get('language') || undefined,
                crawled: url.searchParams.has('crawled') ? booleanParam(url.searchParams, 'crawled') : undefined,
                maxPages: integerParam(url.searchParams, 'maxPages', 500),
            });

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
            if (route === 'GET /search-console/reports' || route === 'GET /search-console/navigation') {
                await ensureSearchConsole();
                return sendJson(200, client.getSearchConsoleReports(url.searchParams.get('property') || undefined));
            }
            if (route === 'GET /search-console/report') {
                await ensureSearchConsole();
                return sendJson(200, await client.getSearchConsoleReport(reportOptions()));
            }
            if (route === 'GET /search-console/report.csv') {
                await ensureSearchConsole();
                const options = reportOptions();
                options.allPages = booleanParam(url.searchParams, 'allPages', true);
                const report = await client.getSearchConsoleReport(options);
                return sendCsv(
                    toCsv(report, integerParam(url.searchParams, 'table', 0)),
                    `${options.report}.csv`,
                );
            }
            if (route === 'GET /search-console/performance' || route === 'GET /search-console/graph') {
                await ensureSearchConsole();
                const options = performanceOptions();
                if (route.endsWith('/graph')) options.dimension = 'days';
                return sendJson(200, await client.getPerformance(options));
            }
            if (route === 'GET /search-console/performance.csv') {
                await ensureSearchConsole();
                const options = performanceOptions();
                options.allPages = booleanParam(url.searchParams, 'allPages', true);
                const report = await client.getPerformance(options);
                return sendCsv(
                    toCsv(report, integerParam(url.searchParams, 'table', 0)),
                    `performance-${options.dimension}.csv`,
                );
            }
            if (route === 'GET /search-console/time-gaps') {
                await ensureSearchConsole();
                return sendJson(200, await client.getPerformanceTimeGaps(performanceOptions()));
            }
            if (route === 'GET /search-console/summary') {
                await ensureSearchConsole();
                return sendJson(200, await client.getSearchConsoleSummary({
                    property: url.searchParams.get('property') || undefined,
                    period: url.searchParams.get('period') || '28-days',
                }));
            }
            if (route === 'GET /search-console/notifications') {
                await ensureSearchConsole();
                return sendJson(200, await client.getNotifications());
            }
            if (route === 'GET /search-console/links') {
                await ensureSearchConsole();
                const report = await client.getLinks({
                    property: url.searchParams.get('property') || undefined,
                    maxPages: integerParam(url.searchParams, 'maxPages', 500),
                });
                return sendJson(report.complete ? 200 : 206, report);
            }
            if (route === 'GET /search-console/url-inspection') {
                await ensureSearchConsole();
                const inspectedUrl = url.searchParams.get('url');
                if (!inspectedUrl) throw new TypeError('url is required');
                return sendJson(200, await client.inspectUrl(inspectedUrl, {
                    property: url.searchParams.get('property') || undefined,
                }));
            }
            if (route === 'POST /search-console/url-inspection') {
                await ensureSearchConsole();
                if (!body.url) throw new TypeError('url is required');
                return sendJson(200, await client.inspectUrl(body.url, {
                    property: body.property,
                    action: body.action,
                }));
            }
            if (route === 'GET /search-console/sitemaps') {
                await ensureSearchConsole();
                return sendJson(200, await client.getSearchConsoleReport({
                    report: 'sitemaps',
                    property: url.searchParams.get('property') || undefined,
                    allPages: booleanParam(url.searchParams, 'allPages'),
                    maxPages: integerParam(url.searchParams, 'maxPages', 50),
                }));
            }
            if (route === 'POST /search-console/sitemaps') {
                await ensureSearchConsole();
                if (!body.sitemap) throw new TypeError('sitemap is required');
                return sendJson(200, await client.submitSitemap(body.sitemap, { property: body.property }));
            }
            if (route === 'GET /search-console/indexing' || route === 'GET /search-console/validations') {
                await ensureSearchConsole();
                return sendJson(200, await client.getSearchConsoleReport({
                    report: 'indexing',
                    property: url.searchParams.get('property') || undefined,
                    allPages: booleanParam(url.searchParams, 'allPages'),
                    maxPages: integerParam(url.searchParams, 'maxPages', 50),
                }));
            }
            if (route === 'GET /search-console/indexing/pages' || route === 'GET /search-console/indexing/pages.csv') {
                await ensureSearchConsole();
                const report = await client.getIndexingPages(indexingPagesOptions());
                if (route.endsWith('.csv')) {
                    if (!report.complete) {
                        const error = new Error('Search Console extraction is incomplete; use the JSON endpoint for details');
                        error.status = 502;
                        throw error;
                    }
                    return sendCsv(toCsv({ tables: [{
                        headers: ['URL', 'Status', 'Reason', 'Last crawled'],
                        rows: report.pages.map((page) => [page.url, page.status, page.reason, page.lastCrawled]),
                    }] }), 'indexing-pages.csv');
                }
                return sendJson(report.complete ? 200 : 206, report);
            }
            if (route === 'POST /search-console/control' || route === 'POST /search-console/filter') {
                await ensureSearchConsole();
                return sendJson(200, await client.controlSearchConsole(body));
            }
            if (route === 'GET /pagespeed/report' || route === 'GET /pagespeed/report.csv') {
                const target = url.searchParams.get('url');
                if (!target) throw new TypeError('url is required');
                const requestedCategories = url.searchParams.getAll('category')
                    .flatMap((category) => category.split(',')).filter(Boolean);
                const strategy = url.searchParams.get('strategy') || 'mobile';
                let report;
                try {
                    report = await client.getPageSpeedReport(target, {
                        strategy,
                        categories: requestedCategories.length
                            ? requestedCategories
                            : ['performance', 'accessibility', 'best-practices', 'seo'],
                        locale: url.searchParams.get('locale') || 'en',
                        apiKey: process.env.PAGESPEED_API_KEY,
                        raw: booleanParam(url.searchParams, 'raw'),
                    });
                } catch (error) {
                    if (![403, 429].includes(error.status)) throw error;
                    await ensureSearchConsole();
                    report = await client.getPageSpeedWebReport(target, { strategy });
                    report.apiError = error.message;
                }
                if (route.endsWith('.csv')) {
                    return sendCsv(toCsv({ tables: [{
                        headers: ['ID', 'Title', 'Score', 'Display value', 'Numeric value', 'Unit'],
                        rows: report.audits.map((audit) => [
                            audit.id,
                            audit.title,
                            audit.score,
                            audit.displayValue,
                            audit.numericValue,
                            audit.numericUnit,
                        ]),
                    }] }), `pagespeed-${report.strategy}.csv`);
                }
                return sendJson(200, report);
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
