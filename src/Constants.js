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

exports.SearchConsoleReports = Object.freeze({
    overview: '',
    insights: 'performance/insights',
    performance: 'performance/search-analytics',
    'ai-performance': 'performance/search-analytics/ai',
    indexing: 'index',
    sitemaps: 'sitemaps',
    removals: 'removals',
    'core-web-vitals': 'core-web-vitals',
    https: 'https',
    'product-snippets': 'r/product',
    'merchant-listings': 'r/merchant-listings',
    'merchant-opportunities': 'merchant-opportunities',
    breadcrumbs: 'r/breadcrumbs',
    'manual-actions': 'manual-actions',
    'security-issues': 'security-issues',
    links: 'links',
    achievements: 'achievements',
    settings: 'settings',
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
