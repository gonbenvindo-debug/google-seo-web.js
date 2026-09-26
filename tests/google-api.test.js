'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const GoogleApiClient = require('../src/google-api');
const { GoogleAdsReports, MerchantCenterReports } = require('../src/Constants');
const { createApiServer } = require('../server');

const oauthEnv = {
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    GOOGLE_OAUTH_REFRESH_TOKEN: 'refresh-token',
};

test('Merchant Center catalog exposes product, feed, promotion and reporting areas', () => {
    for (const name of ['products', 'diagnostics', 'performance', 'data-sources', 'promotions']) {
        assert.ok(Object.hasOwn(MerchantCenterReports, name));
    }
});

test('Google Ads catalog exposes campaign management and optimization areas', () => {
    for (const name of ['campaigns', 'asset-groups', 'shopping-products', 'conversion-goals', 'recommendations', 'billing']) {
        assert.ok(Object.hasOwn(GoogleAdsReports, name));
    }
});

test('Merchant API request refreshes OAuth and preserves query and payload', async () => {
    const calls = [];
    const client = new GoogleApiClient({
        env: oauthEnv,
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), options });
            if (String(url).includes('oauth2.googleapis.com')) {
                return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200 });
            }
            return new Response(JSON.stringify({ products: [] }), { status: 200 });
        },
    });

    const result = await client.requestMerchant({
        path: 'products/v1/accounts/123/products',
        query: { pageSize: 50, pageToken: 'next/page' },
    });
    assert.deepEqual(result, { status: 200, data: { products: [] } });
    assert.match(calls[1].url, /^https:\/\/merchantapi\.googleapis\.com\/products\/v1\/accounts\/123\/products\?/);
    assert.equal(calls[1].options.headers.Authorization, 'Bearer access-token');
    assert.equal(new URL(calls[1].url).searchParams.get('pageToken'), 'next/page');
});

test('Merchant API refuses unsupported namespaces and path traversal', async () => {
    const client = new GoogleApiClient({ env: { GOOGLE_ACCESS_TOKEN: 'token' }, fetchImpl: async () => { throw new Error('must not fetch'); } });
    await assert.rejects(client.requestMerchant({ path: 'https://example.com/steal' }), /supported Merchant API/);
    await assert.rejects(client.requestMerchant({ path: 'products/v1/accounts/../products' }), /supported Merchant API/);
    await assert.rejects(client.requestMerchant({ path: 'products/v1/accounts/%E0%A4%A' }), /invalid URL encoding/);
});

test('Google Ads GAQL request uses developer token, manager id and API version', async () => {
    const calls = [];
    const client = new GoogleApiClient({
        env: { ...oauthEnv, GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token', GOOGLE_ADS_API_VERSION: 'v24' },
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), options });
            if (String(url).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
            return new Response(JSON.stringify({ results: [] }), { status: 200 });
        },
    });

    await client.requestGoogleAds({
        customerId: '1234567890',
        path: 'googleAds:search',
        body: { query: 'SELECT customer.id FROM customer' },
        loginCustomerId: '111-222-3333',
    });
    assert.equal(calls[1].url, 'https://googleads.googleapis.com/v24/customers/1234567890/googleAds:search');
    assert.equal(calls[1].options.headers['developer-token'], 'dev-token');
    assert.equal(calls[1].options.headers['login-customer-id'], '1112223333');
    assert.equal(JSON.parse(calls[1].options.body).query, 'SELECT customer.id FROM customer');
});

test('Google Ads exposes remaining access and conversion-upload actions', async () => {
    const calls = [];
    const client = new GoogleApiClient({
        env: { GOOGLE_ACCESS_TOKEN: 'access-token', GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token' },
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), options });
            return new Response(JSON.stringify({ results: [] }), { status: 200 });
        },
    });
    await client.requestGoogleAds({ path: 'customers:listAccessibleCustomers', method: 'GET' });
    await client.requestGoogleAds({ customerId: '1234567890', path: 'conversionUploads:uploadClickConversions', body: { conversions: [] } });
    await client.requestGoogleAds({ customerId: '1234567890', path: 'offlineUserDataJobs/321:addOperations', body: { operations: [] } });
    assert.equal(calls[0].url, 'https://googleads.googleapis.com/v24/customers:listAccessibleCustomers');
    assert.equal(calls[1].url, 'https://googleads.googleapis.com/v24/customers/1234567890/conversionUploads:uploadClickConversions');
    assert.equal(calls[2].url, 'https://googleads.googleapis.com/v24/customers/1234567890/offlineUserDataJobs/321:addOperations');
});

test('Google Ads mutation paths are constrained and non-POST requests rejected', async () => {
    const client = new GoogleApiClient({
        env: { GOOGLE_ACCESS_TOKEN: 'token', GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token' },
        fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    await assert.rejects(client.requestGoogleAds({ customerId: '123456', path: 'arbitrary', body: {} }), /Google Ads search, customer action or resource action/);
    await assert.rejects(client.requestGoogleAds({ customerId: '123456', path: 'campaigns:mutate', method: 'PATCH' }), /must use POST/);
});

test('Google API error status and safe error details are surfaced', async () => {
    const client = new GoogleApiClient({
        env: { GOOGLE_ACCESS_TOKEN: 'token' },
        fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'permission denied' } }), { status: 403 }),
    });
    await assert.rejects(client.requestMerchant({ path: 'accounts/v1/accounts' }), (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.message, 'permission denied');
        return true;
    });
});

test('HTTP API forwards Merchant REST paths and Google Ads GAQL requests', async (context) => {
    const calls = [];
    const client = {
        getMerchantCenterReports: () => Object.keys(MerchantCenterReports).map((name) => ({ name })),
    };
    const googleApiClient = {
        requestMerchant: async (options) => {
            calls.push({ service: 'merchant', ...options });
            return { status: 200, data: { products: [] } };
        },
        requestGoogleAds: async (options) => {
            calls.push({ service: 'ads', ...options });
            return { status: 200, data: { results: [] } };
        },
    };
    const server = createApiServer(client, { googleApiClient });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;

    const merchantResponse = await fetch(`${base}/api/merchant/products/v1/accounts/123/products?pageSize=5`);
    assert.equal(merchantResponse.status, 200);
    assert.equal(calls[0].path, 'products/v1/accounts/123/products');
    assert.equal(calls[0].query.pageSize, '5');

    const adsResponse = await fetch(`${base}/api/google-ads/1234567890/googleAds:search?loginCustomerId=111-222-3333`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT customer.id FROM customer' }),
    });
    assert.equal(adsResponse.status, 200);
    assert.equal(calls[1].customerId, '1234567890');
    assert.equal(calls[1].path, 'googleAds:search');
    assert.equal(calls[1].loginCustomerId, '111-222-3333');
    assert.equal(calls[1].body.query, 'SELECT customer.id FROM customer');

    const accountsResponse = await fetch(`${base}/api/google-ads/customers:listAccessibleCustomers`);
    assert.equal(accountsResponse.status, 200);
    assert.equal(calls[2].path, 'customers:listAccessibleCustomers');
    assert.equal(calls[2].method, 'GET');

    const ideasResponse = await fetch(`${base}/api/google-ads/1234567890:generateKeywordIdeas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: 'languageConstants/1000' }),
    });
    assert.equal(ideasResponse.status, 200);
    assert.equal(calls[3].path, ':generateKeywordIdeas');
});

test('HTTP Merchant API rejects unknown namespaces before making an upstream request', async (context) => {
    let called = false;
    const server = createApiServer({}, {
        googleApiClient: new GoogleApiClient({
            env: { GOOGLE_ACCESS_TOKEN: 'test-token' },
            fetchImpl: async () => { called = true; return new Response('{}', { status: 200 }); },
        }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/merchant/arbitrary/v1/anything`);
    assert.equal(response.status, 400);
    assert.equal(called, false);
});
