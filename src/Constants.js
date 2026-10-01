'use strict';

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

exports.GoogleAdsReports = Object.freeze({
    overview: 'overview',
    campaigns: 'campaigns',
    'ad-groups': 'adgroups',
    ads: 'ads',
    keywords: 'keywords',
    'search-terms': 'keywords/searchterms',
    'landing-pages': 'landingpages',
    assets: 'assetreport/associations/allupgraded',
    'ad-assets': 'unifiedassetreport/rsaassetdetails',
    audiences: 'audiences/summary',
    conversions: 'conversions',
    attribution: 'attribution/overview',
    'change-history': 'changehistory',
    'keyword-planner': 'keywordplanner/home',
    'data-manager': 'datamanager',
    preferences: 'preferences',
    recommendations: 'recommendations',
    budgets: 'budgets',
    devices: 'devices',
    geographic: 'geographic',
    demographics: 'demographics',
    placements: 'content/placements',
    'negative-keywords': 'keywords/negative',
    'asset-groups': 'assetgroups',
    'shopping-products': 'shopping/products',
    'conversion-goals': 'conversions',
    billing: 'billing/summary',
    'campaign-diagnostics': 'overview/diagnostics',
});

exports.MerchantCenterReports = Object.freeze({
    overview: 'overview',
    products: 'items',
    diagnostics: 'products/diagnostics',
    'product-issues': 'products/diagnostics',
    performance: 'reporting/performance/summary',
    'product-performance': 'reporting/performance/products',
    pricing: 'reporting/performance/pricing',
    'online-store': 'reporting/performance/website',
    'store-quality': 'quality',
    marketing: 'marketingmethods',
    campaigns: 'campaigns',
    promotions: 'promotions',
    'data-sources': 'products/sources',
    'shipping-returns': 'shipping/services',
    policies: 'shipping/services',
    'business-info': 'merchantprofile/businessinfo',
    'business-address': 'merchantprofile/businessaddress/edit',
    'account-issues': 'products/diagnostics/accountissues',
    'add-product': 'directoffers/create',
    notifications: 'taskhub',
    settings: 'accountprefs',
});

exports.Services = Object.freeze({
    'search-console': {
        name: 'Google Search Console', url: 'https://search.google.com/search-console/',
        login: true, reports: exports.SearchConsoleReports,
    },
    'google-ads': {
        name: 'Google Ads', url: 'https://ads.google.com/aw/', home: 'overview',
        login: true, reports: exports.GoogleAdsReports,
        paths: ['/aw/', '/nav/selectaccount'], context: ['euid', 'ocid', 'authuser'],
    },
    'merchant-center': {
        name: 'Google Merchant Center', url: 'https://merchants.google.com/mc/', home: 'overview',
        login: true, reports: exports.MerchantCenterReports, context: ['a', 'account', 'accountId', 'authuser'],
    },
    analytics: {
        name: 'Google Analytics', url: 'https://analytics.google.com/analytics/web/',
        login: true, context: ['authuser'],
    },
    adsense: {
        name: 'Google AdSense', url: 'https://adsense.google.com/adsense/', login: true,
    },
    pagespeed: { name: 'PageSpeed Insights', url: 'https://pagespeed.web.dev/' },
    'rich-results': { name: 'Rich Results Test', url: 'https://search.google.com/test/rich-results' },
    'search-docs': { name: 'Google Search Central', url: 'https://developers.google.com/search/' },
    'schema-validator': { name: 'Schema.org Validator', url: 'https://validator.schema.org/' },
    trends: { name: 'Google Trends', url: 'https://trends.google.com/trends/' },
});

exports.AllowedHosts = new Set([
    ...Object.values(exports.Services).map(({ url }) => new URL(url).hostname),
    'support.google.com',
]);

exports.Events = Object.freeze({
    LOGIN_REQUIRED: 'login',
    AUTHENTICATED: 'authenticated',
    AUTHENTICATION_FAILURE: 'auth_failure',
    READY: 'ready',
    PAGE_CHANGED: 'page_changed',
    DISCONNECTED: 'disconnected',
});
