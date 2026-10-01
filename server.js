'use strict';

const { timingSafeEqual } = require('crypto');
const http = require('http');
const { Services } = require('./src/Constants');

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

function integerParam(parameters, name, fallback, min = 0, max = Infinity) {
    const value = parameters.has(name) ? Number(parameters.get(name)) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new TypeError(name + ' must be an integer between ' + min + ' and ' + max);
    }
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
        if (starting) await starting;
        if (!client.pupBrowser) {
            starting = client.initialize(target).finally(() => { starting = null; });
            await starting;
        } else if (target) {
            await client.open(target);
        }
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
            const needsBody = request.method === 'POST';
            const body = needsBody ? await readJson(request) : {};
            if (needsBody && (!body || typeof body !== 'object' || Array.isArray(body))) {
                throw new TypeError('JSON body must be an object');
            }
            const ensureBrowser = async (service = 'search-console') => {
                if (starting) await starting;
                if (!client.pupBrowser) await start(service);
            };
            const reportOptions = () => ({
                report: url.searchParams.get('report') || 'overview',
                path: url.searchParams.get('path') || undefined,
                property: url.searchParams.get('property') || undefined,
                tab: url.searchParams.get('tab') || undefined,
                allPages: booleanParam(url.searchParams, 'allPages', route.endsWith('.csv')),
                maxPages: integerParam(url.searchParams, 'maxPages', 50, 1, 500),
            });
            const stateOptions = () => ({
                maxText: integerParam(url.searchParams, 'maxText', 30000, 1000, 100000),
                maxElements: integerParam(url.searchParams, 'maxElements', 250, 1, 1000),
            });
            const merchantCatalogOptions = () => ({
                status: url.searchParams.get('status') || 'all',
                query: url.searchParams.get('query') || undefined,
                maxPages: integerParam(url.searchParams, 'maxPages', 50, 1, 500),
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
                allPages: booleanParam(url.searchParams, 'allPages', route.endsWith('.csv')),
                maxPages: integerParam(url.searchParams, 'maxPages', 50, 1, 500),
            });
            const indexingPagesOptions = () => ({
                property: url.searchParams.get('property') || undefined,
                status: url.searchParams.get('status') || 'all',
                reason: url.searchParams.get('reason') || undefined,
                urlContains: url.searchParams.get('urlContains') || undefined,
                language: url.searchParams.get('language') || undefined,
                crawled: url.searchParams.has('crawled') ? booleanParam(url.searchParams, 'crawled') : undefined,
                maxPages: integerParam(url.searchParams, 'maxPages', 500, 1, 500),
            });
            const sendReport = (report, filename) => {
                if (!route.endsWith('.csv')) return sendJson(report.complete === false ? 206 : 200, report);
                if (report.complete !== true && !booleanParam(url.searchParams, 'allowPartial')) {
                    return sendJson(409, { error: 'Cannot verify a complete export. Inspect the JSON report or use allowPartial=true for rendered rows.' });
                }
                return sendCsv(toCsv(report, integerParam(url.searchParams, 'table', 0)), filename);
            };
            const serviceRoute = url.pathname.match(/^\/([^/]+)\/([^/]+?)(\.csv)?$/);
            const service = serviceRoute?.[1];
            const action = serviceRoute?.[2];
            const config = Object.hasOwn(Services, service) ? Services[service] : null;
            if (request.method === 'GET' && config && action === 'reports' && !serviceRoute[3]) {
                return sendJson(200, client.getReports(service, { property: url.searchParams.get('property') || undefined }));
            }

            if (route === 'GET /health' || route === 'GET /auth/status') {
                return sendJson(200, await client.getStatus());
            }
            if (route === 'GET /services') return sendJson(200, Services);
            if (route === 'POST /auth/login' || route === 'POST /browser/start') {
                const target = body.target || body.service || 'search-console';
                client.resolveTarget(target);
                if (route === 'POST /auth/login') {
                    if (starting) await starting;
                    await client.destroy();
                }
                return sendJson(200, await start(target));
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
                return sendJson(200, await client.getState(stateOptions()));
            }
            if (route === 'POST /browser/click') {
                if (!body.id) throw new TypeError('id is required');
                return sendJson(200, await client.click(body.id));
            }
            if (route === 'POST /browser/type') {
                if (!body.id) throw new TypeError('id is required');
                return sendJson(200, await client.type(body.id, body.text, { submit: body.submit ?? false }));
            }
            if (route === 'POST /browser/back') return sendJson(200, await client.back());
            if (route === 'POST /browser/reload') return sendJson(200, await client.reload());
            if (route === 'GET /browser/screenshot') {
                return sendPng(await client.screenshot({ fullPage: booleanParam(url.searchParams, 'fullPage') }));
            }
            if (route === 'POST /browser/stop') {
                await client.destroy();
                return sendJson(200, await client.getStatus());
            }
            if (route === 'GET /merchant-center/catalog' || route === 'GET /merchant-center/catalog.csv') {
                await ensureBrowser('merchant-center');
                const catalog = await client.getMerchantCenterCatalog(merchantCatalogOptions());
                if (route.endsWith('.csv')) {
                    const headers = catalog.products[0] ? Object.keys(catalog.products[0])
                        : catalog.tables?.find(({ headers }) => headers.includes('Product ID'))?.headers || ['Product ID'];
                    return sendReport({ ...catalog, tables: [{ headers, rows: catalog.products.map((product) => headers.map((header) => product[header])) }] }, 'merchant-center-catalog.csv');
                }
                return sendJson(catalog.complete === false ? 206 : 200, catalog);
            }
            if (route === 'POST /merchant-center/product/edit') {
                await ensureBrowser('merchant-center');
                return sendJson(200, await client.openMerchantCenterProduct(body));
            }
            if (route === 'POST /merchant-center/forms/preview') {
                await ensureBrowser('merchant-center');
                return sendJson(200, await client.prepareMerchantCenterForm(body));
            }
            if (route === 'POST /merchant-center/forms/apply') {
                await ensureBrowser('merchant-center');
                return sendJson(200, await client.applyMerchantCenterForm(body));
            }
            if (['GET /search-console/performance', 'GET /search-console/performance.csv', 'GET /search-console/graph'].includes(route)) {
                await ensureBrowser();
                const options = performanceOptions();
                if (route.endsWith('/graph')) options.dimension = 'days';
                return sendReport(await client.getPerformance(options), 'performance-' + options.dimension + '.csv');
            }
            if (route === 'GET /search-console/time-gaps') {
                await ensureBrowser();
                return sendJson(200, await client.getPerformanceTimeGaps(performanceOptions()));
            }
            if (route === 'GET /search-console/summary') {
                await ensureBrowser();
                return sendJson(200, await client.getSearchConsoleSummary({
                    property: url.searchParams.get('property') || undefined,
                    period: url.searchParams.get('period') || '28-days',
                }));
            }
            if (route === 'GET /search-console/notifications') {
                await ensureBrowser();
                return sendJson(200, await client.getNotifications({ property: url.searchParams.get('property') || undefined }));
            }
            if (route === 'GET /search-console/links') {
                await ensureBrowser();
                const report = await client.getLinks({
                    property: url.searchParams.get('property') || undefined,
                    maxPages: integerParam(url.searchParams, 'maxPages', 500, 1, 500),
                });
                return sendJson(report.complete ? 200 : 206, report);
            }
            if (route === 'GET /search-console/url-inspection') {
                await ensureBrowser();
                const inspectedUrl = url.searchParams.get('url');
                if (!inspectedUrl) throw new TypeError('url is required');
                return sendJson(200, await client.inspectUrl(inspectedUrl, {
                    property: url.searchParams.get('property') || undefined,
                }));
            }
            if (route === 'POST /search-console/url-inspection') {
                await ensureBrowser();
                if (!body.url) throw new TypeError('url is required');
                return sendJson(200, await client.inspectUrl(body.url, {
                    property: body.property,
                    action: body.action,
                }));
            }
            if (route === 'POST /search-console/sitemaps') {
                await ensureBrowser();
                if (!body.sitemap) throw new TypeError('sitemap is required');
                return sendJson(200, await client.submitSitemap(body.sitemap, { property: body.property }));
            }
            if (route === 'GET /search-console/validations') {
                await ensureBrowser();
                return sendReport(await client.getReport('search-console', { ...reportOptions(), report: 'indexing' }), 'indexing.csv');
            }
            if (route === 'GET /search-console/indexing/pages' || route === 'GET /search-console/indexing/pages.csv') {
                await ensureBrowser();
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
            if (route === 'GET /google-ads/accounts') {
                await ensureBrowser('google-ads');
                return sendJson(200, await client.getGoogleAdsAccounts());
            }
            if (route === 'POST /google-ads/keyword-ideas' || route === 'POST /google-ads/keyword-forecast') {
                await ensureBrowser('google-ads');
                return sendReport(await client.planGoogleAdsKeywords({
                    ...body, mode: action === 'keyword-ideas' ? 'ideas' : 'forecast',
                }), 'keyword-planner.csv');
            }
            const namedReport = config && Object.hasOwn(config.reports || { overview: '' }, action);
            const genericRead = config && request.method === 'GET' &&
                !(service === 'pagespeed' && action === 'report') &&
                (action === 'report' || namedReport || (!serviceRoute[3] && ['state', 'navigation'].includes(action)));
            const genericWrite = config && request.method === 'POST' && !serviceRoute[3] &&
                (['navigate', 'control', 'filter'].includes(action) || (service === 'google-ads' && action === 'account'));
            if (genericRead || genericWrite) {
                const options = reportOptions();
                if (genericRead) {
                    integerParam(url.searchParams, 'table', 0);
                    booleanParam(url.searchParams, 'allowPartial');
                } else if (['navigate', 'account'].includes(action) && typeof (body.target ?? body.url) !== 'string') {
                    throw new TypeError('target is required and must be a path or URL within this service');
                }
                await ensureBrowser(service);
                if (action === 'state') return sendJson(200, await client.getServiceState(service, stateOptions()));
                if (action === 'navigation') return sendJson(200, await client.getNavigation(service));
                if (action === 'control' || action === 'filter') return sendJson(200, await client.control(service, body));
                if (action === 'navigate' || action === 'account') {
                    return sendJson(200, await client.navigate(service, body.target ?? body.url));
                }
                return sendReport(await client.getReport(service, {
                    ...options, report: action === 'report' ? options.report : action,
                }), service + '-' + action + '.csv');
            }
            if (route === 'GET /pagespeed/report' || route === 'GET /pagespeed/report.csv') {
                const target = url.searchParams.get('url');
                if (!target) throw new TypeError('url is required');
                await ensureBrowser('pagespeed');
                const report = await client.getPageSpeedReport(target, { strategy: url.searchParams.get('strategy') || 'mobile' });
                if (route.endsWith('.csv')) {
                    return sendCsv(toCsv({ tables: [{
                        headers: ['ID', 'Title'],
                        rows: report.audits.map((audit) => [audit.id, audit.title]),
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
    const Client = require('./src/Client');
    const port = Number(process.env.PORT || process.env.GOOGLE_SEO_API_PORT || 3100);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be an integer between 1 and 65535');
    }
    const client = new Client();
    const server = createApiServer(client, { apiKey: process.env.API_KEY || process.env.GOOGLE_SEO_API_KEY });
    server.listen(port, '127.0.0.1', () => {
        console.log(`Google Tools Manager ready at http://127.0.0.1:${port}`);
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
