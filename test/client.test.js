'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Client, Services } = require('..');
const { createApiServer } = require('../server');

test('resolves service aliases and rejects URLs outside the SEO allowlist', () => {
    const client = new Client();
    assert.deepEqual(client.resolveTarget('search-console'), {
        service: 'search-console',
        url: Services['search-console'].url,
    });
    assert.equal(
        client.resolveTarget('https://pagespeed.web.dev/analysis/example').service,
        'pagespeed',
    );
    assert.throws(() => client.resolveTarget('https://search.google.com.evil.test/'), /not allowed/);
    assert.throws(() => client.resolveTarget('file:///etc/passwd'), /not allowed/);
});

test('closes the compact login browser and relaunches headless', async () => {
    const client = new Client();
    let closed = false;
    let launchedWith;
    client.pupBrowser = { close: async () => { closed = true; } };
    client._browserProcess = { exitCode: 0, kill: () => assert.fail('cleanly closed browser must not be killed') };
    client._launchBrowser = async (options) => { launchedWith = options; };

    await client._restartHeadless();

    assert.equal(closed, true);
    assert.equal(launchedWith.headless, true);
    assert.deepEqual(launchedWith.args, ['--window-size=520,760']);
    assert.equal(client._destroying, false);
});

test('accepts only an authenticated Search Console application page', async () => {
    const client = new Client();
    client._isAuthenticated = async () => true;
    client.pupPage = {
        url: () => 'https://search.google.com/search-console/about',
        evaluate: async () => true,
    };
    assert.equal(await client._isSearchConsoleAuthenticated(), false);

    client.pupPage.url = () => 'https://search.google.com/search-console?resource_id=sc-domain:example.com';
    assert.equal(await client._isSearchConsoleAuthenticated(), true);
});

test('serves the LLM browser-control endpoints', async (t) => {
    let running = false;
    const calls = [];
    const status = () => ({
        running,
        service: running ? 'search-console' : null,
        url: running ? Services['search-console'].url : null,
        title: running ? 'Search Console' : null,
        googleSession: running ? 'required' : 'unknown',
    });
    const client = {
        pupBrowser: null,
        getStatus: async () => status(),
        initialize: async (target) => {
            calls.push(['initialize', target]);
            running = true;
            client.pupBrowser = {};
        },
        open: async (target) => calls.push(['open', target]) && status(),
        getState: async () => ({ ...status(), bodyText: 'Resumo', elements: [] }),
        click: async (id) => calls.push(['click', id]) && status(),
        type: async (id, text, options) => calls.push(['type', id, text, options]) && status(),
        back: async () => calls.push(['back']) && status(),
        reload: async () => calls.push(['reload']) && status(),
        screenshot: async () => Buffer.from('png'),
        destroy: async () => {
            calls.push(['destroy']);
            running = false;
            client.pupBrowser = null;
        },
        resetSession: async () => {
            calls.push(['resetSession']);
            running = false;
            client.pupBrowser = null;
        },
    };
    const server = createApiServer(client, { apiKey: 'secret' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
    }));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = (path, { method = 'GET', body, key = 'secret' } = {}) => fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${key}`,
            Connection: 'close',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    assert.equal((await request('/health', { key: 'wrong' })).status, 401);
    assert.equal((await request('/services')).status, 200);
    assert.equal((await request('/browser/state')).status, 200);
    assert.equal((await request('/auth/login', { method: 'POST', body: {} })).status, 200);
    assert.equal((await request('/browser/open', {
        method: 'POST',
        body: { target: 'pagespeed' },
    })).status, 200);
    assert.equal((await request('/browser/click', { method: 'POST', body: { id: 'e7' } })).status, 200);
    assert.equal((await request('/browser/type', {
        method: 'POST',
        body: { id: 'e8', text: 'iberflag.com', submit: true },
    })).status, 200);
    assert.equal((await request('/browser/screenshot')).headers.get('content-type'), 'image/png');
    assert.equal((await request('/auth/logout', { method: 'POST', body: {} })).status, 200);
    assert.equal((await request('/auth/login', { method: 'POST', body: {} })).status, 200);
    assert.equal((await request('/browser/stop', { method: 'POST', body: {} })).status, 200);
    assert.deepEqual(calls, [
        ['initialize', 'search-console'],
        ['open', 'pagespeed'],
        ['click', 'e7'],
        ['type', 'e8', 'iberflag.com', { submit: true }],
        ['resetSession'],
        ['initialize', 'search-console'],
        ['destroy'],
    ]);
});
