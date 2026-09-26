'use strict';

const MERCHANT_API_HOST = 'https://merchantapi.googleapis.com';
const GOOGLE_ADS_API_HOST = 'https://googleads.googleapis.com';
const DEFAULT_ADS_API_VERSION = 'v24';

class GoogleApiClient {
    constructor({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
        if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
        this.env = env;
        this.fetch = fetchImpl;
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.tokenRefresh = null;
    }

    async requestMerchant({ path, method = 'GET', query, body } = {}) {
        const apiPath = this._merchantPath(path);
        return this._request(`${MERCHANT_API_HOST}/${apiPath}`, {
            method: this._method(method),
            query,
            body,
            headers: { Authorization: `Bearer ${await this._getAccessToken()}` },
        });
    }

    async requestGoogleAds({ customerId, path, method = 'POST', query, body, loginCustomerId } = {}) {
        const accessibleCustomers = path === 'customers:listAccessibleCustomers';
        if (String(method).toUpperCase() !== (accessibleCustomers ? 'GET' : 'POST')) {
            throw new TypeError(accessibleCustomers ? 'customers:listAccessibleCustomers must use GET' : 'Google Ads API requests must use POST');
        }
        if (!this.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
            const error = new Error('Set GOOGLE_ADS_DEVELOPER_TOKEN before calling the Google Ads API');
            error.status = 503;
            throw error;
        }
        const version = this.env.GOOGLE_ADS_API_VERSION || DEFAULT_ADS_API_VERSION;
        if (!/^v\d+$/.test(version)) throw new TypeError('GOOGLE_ADS_API_VERSION must look like v24');
        const id = String(customerId || '');
        if (!accessibleCustomers && !/^\d{6,20}$/.test(id)) throw new TypeError('customerId must contain 6 to 20 digits without hyphens');
        if (accessibleCustomers && id && !/^\d{6,20}$/.test(id)) throw new TypeError('customerId must contain 6 to 20 digits without hyphens');
        const apiPath = this._googleAdsPath(path);
        const headers = {
            Authorization: `Bearer ${await this._getAccessToken()}`,
            'developer-token': this.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
        };
        const managerId = String(loginCustomerId || this.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
        if (managerId) {
            if (!/^\d{6,20}$/.test(managerId)) throw new TypeError('loginCustomerId must contain 6 to 20 digits');
            headers['login-customer-id'] = managerId;
        }
        const endpoint = accessibleCustomers
            ? `${GOOGLE_ADS_API_HOST}/${version}/customers:listAccessibleCustomers`
            : `${GOOGLE_ADS_API_HOST}/${version}/customers/${id}${apiPath.startsWith(':') ? apiPath : `/${apiPath}`}`;
        return this._request(endpoint, {
            method: this._method(method), query, body, headers,
        });
    }

    _merchantPath(path) {
        if (typeof path !== 'string' || !path.trim()) throw new TypeError('path is required');
        const normalized = path.trim().replace(/^\/+/, '');
        let decoded;
        try { decoded = decodeURIComponent(normalized); } catch { throw new TypeError('path contains invalid URL encoding'); }
        if (decoded.split('/').includes('..') || !/^(?:accounts|products|reports|datasources|inventories|conversions|notifications|promotions|quota|ordertracking|productstudio)\/v\d+(?:alpha|beta)?(?:\/|$)/.test(decoded)) {
            throw new TypeError('path must target a supported Merchant API v1 resource');
        }
        return normalized;
    }

    _googleAdsPath(path) {
        if (typeof path !== 'string' || !path.trim()) throw new TypeError('path is required');
        const normalized = path.trim().replace(/^\/+/, '');
        let decoded;
        try { decoded = decodeURIComponent(normalized); } catch { throw new TypeError('path contains invalid URL encoding'); }
        if (decoded.split('/').includes('..') || !/^(?:googleAds:(?:search|searchStream)|customers:listAccessibleCustomers|:[A-Za-z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z0-9_-]+)*:[A-Za-z][A-Za-z0-9]*)$/.test(decoded)) {
            throw new TypeError('path must be a Google Ads search, customer action or resource action endpoint');
        }
        return normalized;
    }

    _method(method) {
        const normalized = String(method || '').toUpperCase();
        if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(normalized)) {
            throw new TypeError('method must be GET, POST, PATCH or DELETE');
        }
        return normalized;
    }

    async _getAccessToken() {
        const staticToken = this.env.GOOGLE_ACCESS_TOKEN;
        if (staticToken) return staticToken;
        if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
        if (this.tokenRefresh) return this.tokenRefresh;
        this.tokenRefresh = (async () => {
            const clientId = this.env.GOOGLE_OAUTH_CLIENT_ID;
            const clientSecret = this.env.GOOGLE_OAUTH_CLIENT_SECRET;
            const refreshToken = this.env.GOOGLE_OAUTH_REFRESH_TOKEN;
            if (!clientId || !clientSecret || !refreshToken) {
                const error = new Error('Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REFRESH_TOKEN for direct Google API access');
                error.status = 503;
                throw error;
            }
            const response = await this.fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    refresh_token: refreshToken,
                    grant_type: 'refresh_token',
                }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !payload.access_token) {
                const error = new Error(payload.error_description || payload.error || `Google OAuth returned HTTP ${response.status}`);
                error.status = response.status >= 400 && response.status < 500 ? 401 : 502;
                throw error;
            }
            this.accessToken = payload.access_token;
            this.tokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
            return this.accessToken;
        })().finally(() => { this.tokenRefresh = null; });
        return this.tokenRefresh;
    }

    async _request(endpoint, { method, query, body, headers = {} }) {
        const url = new URL(endpoint);
        if (query !== undefined) {
            if (!query || typeof query !== 'object' || Array.isArray(query)) throw new TypeError('query must be an object');
            for (const [key, value] of Object.entries(query)) {
                if (value === undefined || value === null) continue;
                for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
            }
        }
        const requestHeaders = { Accept: 'application/json', ...headers };
        const options = { method, headers: requestHeaders };
        if (body !== undefined) {
            requestHeaders['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        const response = await this.fetch(url, options);
        const text = await response.text();
        let payload = null;
        if (text) {
            try { payload = JSON.parse(text); } catch { payload = text; }
        }
        if (!response.ok) {
            const message = payload?.error?.message || payload?.error_description || `Google API returned HTTP ${response.status}`;
            const error = new Error(message);
            error.status = response.status;
            error.details = payload;
            throw error;
        }
        return { status: response.status, data: payload };
    }
}

module.exports = GoogleApiClient;
