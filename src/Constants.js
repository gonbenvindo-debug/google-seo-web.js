'use strict';

exports.LoginURL = 'https://accounts.google.com/ServiceLogin?service=sitemaps&continue=https://search.google.com/search-console/';

exports.Services = Object.freeze({
    'search-console': {
        name: 'Google Search Console',
        url: 'https://search.google.com/search-console/',
    },
    pagespeed: {
        name: 'PageSpeed Insights',
        url: 'https://pagespeed.web.dev/',
    },
    'rich-results': {
        name: 'Rich Results Test',
        url: 'https://search.google.com/test/rich-results',
    },
    'merchant-center': {
        name: 'Google Merchant Center',
        url: 'https://merchants.google.com/',
    },
    'search-docs': {
        name: 'Google Search Central',
        url: 'https://developers.google.com/search/',
    },
    'schema-validator': {
        name: 'Schema.org Validator',
        url: 'https://validator.schema.org/',
    },
    trends: {
        name: 'Google Trends',
        url: 'https://trends.google.com/trends/',
    },
});

exports.AllowedHosts = new Set([
    'search.google.com',
    'pagespeed.web.dev',
    'merchants.google.com',
    'developers.google.com',
    'support.google.com',
    'validator.schema.org',
    'trends.google.com',
]);

exports.Events = Object.freeze({
    LOGIN_REQUIRED: 'login',
    AUTHENTICATED: 'authenticated',
    AUTHENTICATION_FAILURE: 'auth_failure',
    READY: 'ready',
    PAGE_CHANGED: 'page_changed',
    DISCONNECTED: 'disconnected',
});
