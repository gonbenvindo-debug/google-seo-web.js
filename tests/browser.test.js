'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout } = require('node:timers/promises');
const { Client, Services } = require('..');
const { createApiServer } = require('../server');

test('service URLs stay scoped and preserve account context without credentials', () => {
    const client = new Client();
    client._contexts['google-ads'] = { euid: '123', ocid: '456' };
    client._contexts['merchant-center'] = { a: '123' };
    const merchant = new URL(client._serviceUrl('merchant-center', 'items'));
    assert.equal(merchant.pathname, '/mc/items');
    assert.equal(merchant.searchParams.get('a'), '123');
    assert.equal(new URL(client._serviceUrl('google-ads', 'campaigns')).searchParams.get('ocid'), '456');
    assert.equal(new URL(client._serviceUrl('google-ads', 'campaigns?euid=789')).searchParams.has('ocid'), false);
    assert.equal(client.resolveTarget('analytics').service, 'analytics');
    assert.equal(client._serviceForUrl('https://adsense.google.com/adsense/u/0/pub-123/home'), 'adsense');
    assert.equal(client._serviceForUrl('https://search.google.com/test/rich-results'), 'rich-results');
    assert.throws(() => client.resolveTarget('__proto__'), /Unknown service|invalid URL/);
    assert.throws(() => client.resolveTarget('https://analytics.google.com:8443/analytics/web/'), /not allowed/);
    for (const target of [
        'http://analytics.google.com/analytics/web/',
        'https://user:password@analytics.google.com/analytics/web/',
        'https://analytics.google.com/analytics/web/../../outside',
        'https://adsense.google.com/adsense/',
    ]) assert.throws(() => client._serviceUrl('analytics', target), /URL must stay within/);
    assert.throws(() => client._searchConsoleUrl('http://search.google.com/search-console/', 'sc-domain:example.com'), /URL must stay within/);
    assert.throws(() => client.getReports('constructor'), /Unknown service/);
    assert.ok(client.getReports('search-console', { property: 'sc-domain:example.com' })
        .every(({ url }) => new URL(url).searchParams.get('resource_id') === 'sc-domain:example.com'));
});

test('HTTP routes share startup, validate input and protect incomplete exports', async (t) => {
    const client = new Client();
    const calls = [];
    let starts = 0;
    client.initialize = async () => {
        starts++;
        await setTimeout(15);
        client.pupBrowser = {};
    };
    client.getStatus = async () => ({ running: Boolean(client.pupBrowser) });
    client.destroy = async () => { client.pupBrowser = null; };
    client.getReport = async (service, options) => {
        calls.push({ service, options });
        return { service, complete: options.report === 'campaigns' ? false : null,
            tables: [{ headers: ['Name'], rows: [['a,"b"']] }] };
    };
    client.getServiceState = async (service, options) => ({ service, ...options });
    client.navigate = async (service, target) => ({ service, target });
    client.getPageSpeedReport = async () => ({ strategy: 'mobile', audits: [{ id: 'audit', title: 'Audit' }] });
    const server = createApiServer(client, { apiKey: 'local-key' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = (path, options = {}) => fetch(base + path, {
        ...options, headers: { Authorization: 'Bearer local-key', ...options.headers },
    });
    assert.equal((await fetch(base + '/services')).status, 401);
    for (const service of ['analytics', 'adsense', 'merchant-center', 'google-ads']) {
        assert.equal((await request('/' + service + '/reports')).status, 200);
    }
    for (const path of ['/analytics/missing', '/constructor/report', '/api/merchant/accounts/v1/accounts']) {
        assert.equal((await request(path)).status, 404);
    }
    assert.equal((await request('/analytics/report?maxPages=0')).status, 400);
    assert.equal(starts, 0);
    const responses = await Promise.all([request('/analytics/report'), request('/merchant-center/products')]);
    assert.ok(responses.every(({ status }) => status === 200));
    assert.equal(starts, 1);
    assert.deepEqual(calls.slice(0, 2).map(({ service }) => service).sort(), ['analytics', 'merchant-center']);
    assert.equal((await request('/google-ads/campaigns')).status, 206);
    assert.equal((await request('/adsense/overview.csv')).status, 409);
    const csv = await request('/adsense/overview.csv?allowPartial=true');
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /"a,""b"""/);
    assert.equal(calls.at(-1).options.allPages, true);
    const state = await request('/analytics/state?maxElements=5');
    assert.equal((await state.json()).maxElements, 5);
    assert.equal((await request('/analytics/navigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' })).status, 400);
    assert.equal((await request('/analytics/navigate', { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await request('/analytics/navigate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'x'.repeat(100000) }),
    })).status, 413);
    const pagespeed = await request('/pagespeed/report?url=https%3A%2F%2Fexample.com');
    assert.equal((await pagespeed.json()).audits[0].id, 'audit');
    assert.equal((await request('/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"service":"analytics"}',
    })).status, 200);
    assert.equal(starts, 2);
});

test('Search Console summary keeps the property from its first report', async () => {
    const client = new Client();
    const properties = [];
    client.getPerformance = async () => ({ property: 'sc-domain:example.com', tables: [] });
    client.getSearchConsoleReport = async ({ property }) => {
        properties.push(property);
        client._searchConsoleResource = 'sc-domain:other.com';
        return { tables: [] };
    };
    client.getNotifications = async ({ property }) => { properties.push(property); };
    const summary = await client.getSearchConsoleSummary();
    assert.equal(summary.property, 'sc-domain:example.com');
    assert.deepEqual(properties, Array(6).fill(summary.property));
});

test('Puppeteer extracts rendered tables and controls, rejects ambiguous actions and recovers the queue', async (t) => {
    const client = new Client();
    await client._launchBrowser({ headless: true });
    t.after(() => client.destroy());
    const html = '<h1>Stats</h1><button>Clicks<br>12</button>' +
        '<button onclick="window.saved=true">Save</button><button onclick="window.saved=true">Save</button>' +
        '<input aria-label="Filter"><input aria-label="Password" type="password" value="private">' +
        '<table aria-label="Rows"><tr><th>Page</th><th>Views</th></tr>' +
        '<tr><td>Home</td><td>12</td></tr><tr><td>Contact</td><td>4</td></tr>' +
        '<tr style="display:none"><td>Hidden</td><td>999</td></tr></table><p>1-2 of 2</p>';
    await client.pupPage.setRequestInterception(true);
    client.pupPage.on('request', (request) => request.respond({ status: 200, contentType: 'text/html', body: html }));
    await client.pupPage.goto(Services.trends.url);
    const report = await client.getReport('trends', { report: 'current' });
    assert.deepEqual(report.tables[0].rows, [['Home', '12'], ['Contact', '4']]);
    assert.equal(report.complete, true);
    assert.equal(report.metrics.find(({ label }) => label === 'Clicks').value, '12');
    assert.equal(report.controls.find(({ label }) => label === 'Password').value, undefined);
    const state = await client.getState();
    await assert.rejects(client.type(state.elements.find(({ type }) => type === 'password').id, 'change'), /not editable/);
    await assert.rejects(client.control('trends', { label: 'Save' }), /Ambiguous control/);
    assert.equal(await client.pupPage.evaluate(() => Boolean(window.saved)), false);
    await client.control('trends', { label: 'Filter', text: 'reused' });
    assert.equal((await client.getState()).elements.find(({ label }) => label === 'Filter').value, 'reused');
    const [, nextState] = await Promise.all([client.navigate('trends', ''), client.getState()]);
    assert.equal(nextState.headings[0], 'Stats');
});
