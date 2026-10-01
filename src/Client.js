'use strict';

const { spawn } = require('child_process');
const { EventEmitter, once } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const puppeteer = require('puppeteer');
const LocalAuth = require('./authStrategies/LocalAuth');
const snapshot = require('./page');
const {
    AllowedHosts,
    Events,
    GoogleAdsReports,
    SearchConsoleReports,
    Services,
} = require('./Constants');

const DEFAULT_OPTIONS = {
    authTimeoutMs: 0,
    defaultService: 'search-console',
    headlessAfterLogin: true,
    puppeteer: {
        headless: false,
        defaultViewport: null,
        args: ['--window-size=520,760'],
    },
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class Client extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            ...DEFAULT_OPTIONS,
            ...options,
            puppeteer: { ...DEFAULT_OPTIONS.puppeteer, ...options.puppeteer },
        };
        if (!Object.hasOwn(Services, this.options.defaultService)) throw new TypeError('Unknown default service');
        this.authStrategy = options.authStrategy || new LocalAuth();
        this.authStrategy.setup(this);
        this.pupBrowser = null;
        this.pupPage = null;
        this._browserProcess = null;
        this._destroying = false;
        this._pageQueue = Promise.resolve();
        this._searchConsoleResource = options.searchConsoleProperty || null;
        this._contexts = {};
    }

    async initialize(target = this.options.defaultService) {
        if (this.pupBrowser) throw new Error('Client is already initialized');
        const destination = this.resolveTarget(target);
        const service = destination.service;
        const loginUrl = Services[service]?.login
            ? 'https://accounts.google.com/ServiceLogin?continue=' + encodeURIComponent(destination.url)
            : null;
        this._destroying = false;
        try {
            await this.authStrategy.beforeBrowserInitialized();
            await this._launchBrowser({ ...this.options.puppeteer, headless: true });
            await this.pupPage.goto(destination.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await this._waitForPage();
            let visibleLogin = false;
            if (loginUrl && !(await this._isServiceAuthenticated(service))) {
                visibleLogin = this.options.puppeteer.headless === false;
                if (visibleLogin) await this._restartBrowser(this.options.puppeteer);
                this.emit(Events.LOGIN_REQUIRED, { url: loginUrl });
                await this.pupPage.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                try {
                    await this._waitForAuthentication(service, loginUrl);
                } catch (error) {
                    this.emit(Events.AUTHENTICATION_FAILURE, error.message);
                    throw error;
                }
            }
            if (visibleLogin && this.options.headlessAfterLogin) {
                await this._restartBrowser({ ...this.options.puppeteer, headless: true });
            } else if (!visibleLogin && !this.options.headlessAfterLogin && this.options.puppeteer.headless === false) {
                await this._restartBrowser(this.options.puppeteer);
            }
            await this.open(target);
            if (loginUrl) {
                await this._requireService(service);
                this.emit(Events.AUTHENTICATED);
            }
            this.emit(Events.READY, await this.getStatus());
            return this;
        } catch (error) {
            await this.destroy().catch(() => {});
            throw error;
        }
    }

    resolveTarget(target = this.options.defaultService) {
        if (Object.hasOwn(Services, target)) return { service: target, url: this._serviceUrl(target) };

        let url;
        try {
            url = new URL(String(target));
        } catch {
            throw new TypeError(`Unknown service or invalid URL: ${target}`);
        }
        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.port ||
            !AllowedHosts.has(url.hostname)
        ) {
            throw new TypeError(`URL host is not allowed: ${url.hostname || target}`);
        }
        return {
            service: this._serviceForUrl(url.href),
            url: url.href,
        };
    }

    open(target) {
        return this._runPageTask(async () => {
            this._requirePage();
            const destination = this.resolveTarget(target);
            await this.pupPage.goto(destination.url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });
            await this._waitForPage();
            const status = await this.getStatus();
            this.emit(Events.PAGE_CHANGED, status);
            return status;
        });
    }

    async getStatus() {
        if (!this.pupPage) {
            return {
                running: false,
                service: null,
                url: null,
                title: null,
                googleSession: 'unknown',
            };
        }
        const url = this.pupPage.url();
        const service = this._serviceForUrl(url);
        const current = new URL(url);
        const resource = service === 'search-console' && current.searchParams.get('resource_id');
        if (resource) this._searchConsoleResource = resource;
        const context = Object.fromEntries((Services[service]?.context || [])
            .filter((name) => current.searchParams.has(name))
            .map((name) => [name, current.searchParams.get(name)]));
        if (Object.keys(context).length) this._contexts[service] = context;
        const hasGoogleSession = await this._isAuthenticated();
        return {
            running: true,
            service,
            account: this._contexts[service] || {},
            url,
            title: await this.pupPage.title(),
            googleSession: url.includes('accounts.google.com') || url.includes('/search-console/about')
                ? 'required'
                : hasGoogleSession ? 'present' : 'unknown',
        };
    }

    getState(options = {}) {
        return this._runPageTask(() => this._getState(options));
    }

    async _getState({ maxText = 30000, maxElements = 250 } = {}) {
        this._requirePage();
        if (!Number.isInteger(maxText) || maxText < 1000 || maxText > 100000 ||
            !Number.isInteger(maxElements) || maxElements < 1 || maxElements > 1000) {
            throw new TypeError('maxText must be 1000 to 100000; maxElements must be 1 to 1000');
        }
        return { ...(await this.getStatus()), ...(await this.pupPage.evaluate(snapshot, { maxText, maxElements })) };
    }

    getReports(service, { property } = {}) {
        if (!Object.hasOwn(Services, service)) throw new TypeError('Unknown service: ' + service);
        const config = Services[service];
        return Object.entries(config.reports || { overview: config.home || '' }).map(([name, path]) => ({
            name,
            url: service === 'search-console' && (property || this._searchConsoleResource)
                ? this._searchConsoleUrl(path, this._searchConsoleProperty(property))
                : this._serviceUrl(service, path),
        }));
    }

    getReport(service, { report = 'overview', path, property, tab, allPages = false, maxPages = 50 } = {}) {
        return this._runPageTask(async () => {
            if (!Object.hasOwn(Services, service)) throw new TypeError('Unknown service: ' + service);
            if (typeof allPages !== 'boolean' || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
                throw new TypeError('allPages must be boolean; maxPages must be an integer between 1 and 500');
            }
            if (tab !== undefined && (typeof tab !== 'string' || !tab.trim())) throw new TypeError('tab must be a non-empty string');
            const reports = Services[service].reports || { overview: Services[service].home || '' };
            if (path === undefined && report !== 'current' && !Object.hasOwn(reports, report)) {
                throw new TypeError('Unknown report for ' + service + ': ' + report);
            }
            if (path !== undefined || report !== 'current') {
                const target = path === undefined ? reports[report] : path;
                await this._openService(service, service === 'search-console'
                    ? this._searchConsoleUrl(target, this._searchConsoleProperty(property))
                    : target);
            } else {
                await this._requireService(service);
            }
            if (tab) await this._actByLabel(service, [tab], undefined, { selector: '[role="tab"]' });
            return this._collectCurrentReport({ allPages, maxPages });
        });
    }

    getServiceState(service, options = {}) {
        return this._runPageTask(async () => {
            if (this._serviceForUrl(this.pupPage?.url() || 'about:blank') !== service) await this._openService(service);
            await this._requireService(service);
            return this._getState(options);
        });
    }

    getNavigation(service) {
        return this._runPageTask(async () => {
            if (this._serviceForUrl(this.pupPage?.url() || 'about:blank') !== service) await this._openService(service);
            await this._requireService(service);
            const report = await this._extractReport();
            return {
                service, url: report.url, account: report.account, property: report.property,
                links: report.links.filter(({ url }) => this._serviceForUrl(url) === service),
            };
        });
    }

    navigate(service, target) {
        return this._runPageTask(() => this._openService(service, target));
    }

    control(service, { label, text, submit = false, exact = true } = {}) {
        return this._runPageTask(async () => {
            if (typeof label !== 'string' || !label.trim() || (text !== undefined && typeof text !== 'string') ||
                typeof submit !== 'boolean' || typeof exact !== 'boolean') {
                throw new TypeError('label must be a non-empty string; text a string; submit and exact booleans');
            }
            await this._requireService(service);
            await this._actByLabel(service, [label], text, { submit, exact });
            return this._collectCurrentReport();
        });
    }

    getGoogleAdsReports() { return this.getReports('google-ads'); }
    getMerchantCenterReports() { return this.getReports('merchant-center'); }
    getGoogleAdsState() { return this.getServiceState('google-ads'); }
    getMerchantCenterState() { return this.getServiceState('merchant-center'); }
    getMerchantCenterNavigation() { return this.getNavigation('merchant-center'); }
    getGoogleAdsReport(options) { return this.getReport('google-ads', options); }
    getMerchantCenterReport(options) { return this.getReport('merchant-center', options); }
    controlGoogleAds(options) { return this.control('google-ads', options); }
    controlMerchantCenter(options) { return this.control('merchant-center', options); }

    getGoogleAdsAccounts() {
        return this._runPageTask(async () => {
            await this._openService('google-ads', 'https://ads.google.com/nav/selectaccount');
            const state = await this._getState({ maxElements: 1000 });
            return {
                ...state,
                accounts: state.elements.filter(({ label, href }) =>
                    /\b\d{3}-\d{3}-\d{4}\b/.test(label) ||
                    (href && new URL(href).hostname === 'ads.google.com' && new URL(href).searchParams.has('euid')))
                    .map(({ id, label, href }) => ({ id, label, url: href, customerId: label.match(/\b\d{3}-\d{3}-\d{4}\b/)?.[0] })),
            };
        });
    }

    planGoogleAdsKeywords({ keywords, website, mode = 'ideas', entireSite = true, allPages = false, maxPages = 50 } = {}) {
        if (!['ideas', 'forecast'].includes(mode)) throw new TypeError('mode must be ideas or forecast');
        if (keywords !== undefined && (!Array.isArray(keywords) || !keywords.length || keywords.length > 1000 ||
            keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim() || keyword.length > 200))) {
            throw new TypeError('keywords must contain 1 to 1000 non-empty strings of at most 200 characters');
        }
        if ((!keywords && !website) || (mode === 'forecast' && (!keywords || website))) {
            throw new TypeError('ideas requires keywords or website; forecast requires keywords without website');
        }
        if (mode === 'ideas' && keywords?.length > 10) throw new TypeError('Keyword ideas accepts at most 10 seed keywords');
        if (typeof entireSite !== 'boolean' || typeof allPages !== 'boolean' ||
            !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
            throw new TypeError('entireSite and allPages must be booleans; maxPages must be between 1 and 500');
        }
        if (website !== undefined) {
            const url = new URL(website);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
                throw new TypeError('website must be an HTTP(S) URL without credentials');
            }
        }
        return this._runPageTask(async () => {
            await this._openService('google-ads', GoogleAdsReports['keyword-planner']);
            if (mode === 'forecast') {
                await this._actByLabel('google-ads', ['Get search volume and forecasts', 'Obter volume de pesquisas e previsões']);
                await this._actByLabel('google-ads', ['Enter or paste your keywords', 'Enter keywords', 'Introduza palavras-chave'], keywords.join('\n'), { exact: false });
                await this._actByLabel('google-ads', ['Get started', 'Começar']);
            } else {
                await this._actByLabel('google-ads', ['Discover new keywords', 'Descobrir novas palavras-chave']);
                await this._actByLabel('google-ads', keywords ? ['Start with keywords', 'Começar com palavras-chave'] : ['Start with a website', 'Começar com um Website']);
                if (keywords) {
                    await this._actByLabel('google-ads', ['Search input', 'Enter products or services', 'Enter keywords', 'Introduza produtos ou serviços'], keywords.join(', '), { exact: false, submit: true });
                }
                if (website) {
                    await this._actByLabel('google-ads', keywords
                        ? ['Enter a site to filter unrelated keywords', 'Enter a domain to use as a filter', 'Enter your site', 'Introduza o seu site']
                        : ['Enter a site to filter unrelated keywords', 'Enter a domain or a page', 'Enter a website', 'Introduza um domínio'], website, { exact: false });
                    if (!keywords) await this._actByLabel('google-ads', entireSite
                        ? ['Use the entire site', 'Utilizar todo o site']
                        : ['Use only this page', 'Utilizar apenas esta página'], undefined, { exact: false, selector: '[role="radio"], input[type="radio"]' });
                }
                await this._actByLabel('google-ads', ['Get results', 'Obter resultados']);
            }
            const result = await this._collectCurrentReport({ allPages, maxPages });
            if (!result.tables.length && !result.charts.length) {
                throw Object.assign(new Error('Keyword Planner returned no results; inspect /google-ads/state for account requirements or form errors'), { status: 409 });
            }
            return { ...result, mode };
        });
    }

    _serviceUrl(service, target) {
        if (!Object.hasOwn(Services, service)) throw new TypeError('Unknown service: ' + service);
        const config = Services[service];
        target = target === undefined ? config.home || '' : target;
        if (typeof target !== 'string') throw new TypeError('Service path must be a string');
        const url = new URL(target, config.url);
        if (url.protocol !== 'https:' || url.port || url.username || url.password || this._serviceForUrl(url.href) !== service) {
            throw new TypeError('URL must stay within ' + config.url);
        }
        if (!(config.context || []).some((name) => url.searchParams.has(name))) {
            for (const [name, value] of Object.entries(this._contexts[service] || {})) url.searchParams.set(name, value);
        }
        if (service === 'google-ads' && !url.searchParams.has('hl')) url.searchParams.set('hl', 'en');
        return url.href;
    }

    async _openService(service, target) {
        this._requirePage();
        await this.getStatus();
        const requested = new URL(this._serviceUrl(service, target));
        if (!this.options.puppeteer.defaultViewport) await this.pupPage.setViewport({ width: 1440, height: 1000 });
        const response = await this.pupPage.goto(requested.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (response?.status() >= 400) {
            throw Object.assign(new Error(service + ' returned HTTP ' + response.status()), { status: response.status() });
        }
        await this._waitForPage();
        await this._requireService(service);
        const actual = new URL(this.pupPage.url()).pathname.replace(/\/$/, '');
        const expected = requested.pathname.replace(/\/$/, '');
        const base = new URL(Services[service].url).pathname.replace(/\/$/, '');
        if (expected !== base && expected !== '/nav/selectaccount' && actual !== expected && !actual.startsWith(expected + '/')) {
            throw Object.assign(new Error(service + ' redirected to ' + actual + '; inspect /' + service + '/state for available reports.'), { status: 409 });
        }
        return this.getStatus();
    }

    async _waitForPage() {
        await this.pupPage.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch((error) => {
            if (error.name !== 'TimeoutError') throw error;
        });
        await this.pupPage.waitForFunction(() => document.body?.innerText.trim() &&
            ![...document.querySelectorAll('[aria-busy="true"], material-progress [role="progressbar"]:not([aria-valuenow])')]
                .some((element) => element.getBoundingClientRect().width && element.getBoundingClientRect().height &&
                    getComputedStyle(element).visibility !== 'hidden'), { timeout: 30000 });
    }

    async _requireService(service) {
        this._requirePage();
        if (!(await this._isServiceAuthenticated(service))) {
            throw Object.assign(new Error('An authenticated ' + service + ' page is required; open it with POST /auth/login.'), { status: 409 });
        }
        await this.getStatus();
    }

    async _actByLabel(service, labels, text, { submit = false, exact = true, selector } = {}) {
        for (const label of labels) {
            const changed = text === undefined
                ? await this._clickByLabel(label, { exact, unique: true, selector })
                : await this._typeByLabel(label, text, { submit, exact, unique: true });
            if (!changed) continue;
            await this._waitForPage();
            return;
        }
        throw Object.assign(new Error('Control not available: ' + labels[0] + '. Inspect /' + service + '/state for current labels.'), { status: 409 });
    }

    getPageSpeedWebReport(target, options) { return this.getPageSpeedReport(target, options); }

    getPageSpeedReport(target, { strategy = 'mobile' } = {}) {
        return this._runPageTask(async () => {
            this._requirePage();
            let inspectedUrl;
            try {
                inspectedUrl = new URL(target);
            } catch {
                throw new TypeError('url must be a valid HTTP or HTTPS URL');
            }
            if (!['http:', 'https:'].includes(inspectedUrl.protocol) || inspectedUrl.username || inspectedUrl.password) {
                throw new TypeError('url must be a valid HTTP or HTTPS URL');
            }
            if (!['mobile', 'desktop'].includes(strategy)) throw new TypeError('strategy must be mobile or desktop');
            const pageSpeedUrl = new URL('https://pagespeed.web.dev/analysis');
            pageSpeedUrl.searchParams.set('url', inspectedUrl.href);
            pageSpeedUrl.searchParams.set('form_factor', strategy);
            pageSpeedUrl.searchParams.set('hl', 'en');
            await this.pupPage.goto(pageSpeedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            const ready = () => {
                const lines = (document.body?.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
                return ['First Contentful Paint', 'Largest Contentful Paint'].every((metric) =>
                    lines.some((line, index) => line.toLowerCase() === metric.toLowerCase() &&
                        /^[<>]?\d+(?:[.,]\d+)?\s*(?:ms|s)$/i.test(lines[index + 1])));
            };
            try {
                await this.pupPage.waitForFunction(ready, { timeout: 90000 });
            } catch (error) {
                if (error.name !== 'TimeoutError') throw error;
                await this.pupPage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
                await this.pupPage.waitForFunction(ready, { timeout: 60000 }).catch((error) => {
                    if (error.name !== 'TimeoutError') throw error;
                    throw Object.assign(new Error('PageSpeed has not completed the analysis; inspect ' + this.pupPage.url()), { status: 504 });
                });
            }
            await this.pupPage.evaluate(() => {
                [...document.querySelectorAll('button')]
                    .filter((button) => /^(?:Show|Mostrar)$/i.test(button.innerText.trim()))
                    .forEach((button) => button.click());
            });
            await sleep(500);
            return this.pupPage.evaluate(({ requestedUrl, strategy }) => {
                const rawText = String(document.body?.innerText || '')
                    .replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
                const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
                const category = (...names) => {
                    const index = lines.findIndex((line) => names.some((name) => line.toLowerCase() === name));
                    return index > 0 && /^\d+$/.test(lines[index - 1]) ? Number(lines[index - 1]) : null;
                };
                const metric = (...names) => {
                    const index = lines.findIndex((line, index) => names.some((name) => line.toLowerCase() === name) &&
                        /^[<>]?\d+(?:[.,]\d+)?(?:\s*(?:ms|s))?$/i.test(lines[index + 1]));
                    return index >= 0 ? lines[index + 1] || null : null;
                };
                const savings = lines.filter((line) => /(?:estimated savings|poupança estimada)/i.test(line));
                const diagnosticStart = lines.findIndex((line) => /^(?:diagnostics|diagnósticos)$/i.test(line));
                const diagnosticEnd = lines.findIndex((line, index) =>
                    index > diagnosticStart && /^(?:passed audits|auditorias aprovadas)/i.test(line));
                const diagnostics = diagnosticStart >= 0
                    ? lines.slice(diagnosticStart + 1, diagnosticEnd > diagnosticStart ? diagnosticEnd : undefined)
                    : [];
                const headings = [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')]
                    .map((heading) => heading.innerText.trim()).filter(Boolean);
                const auditTitles = headings.filter((heading) =>
                    !/^(?:PageSpeed Insights|Performance|Desempenho|Accessibility|Acessibilidade|Best practices|Práticas recomendadas|SEO)$/i.test(heading));
                const audits = [...new Set([...auditTitles, ...savings, ...diagnostics])];
                return {
                    source: 'pagespeed-web-ui',
                    requestedUrl,
                    reportUrl: location.href,
                    strategy,
                    title: document.title,
                    categories: {
                        performance: { score: category('performance', 'desempenho') },
                        accessibility: { score: category('accessibility', 'acessibilidade') },
                        'best-practices': { score: category('best practices', 'práticas recomendadas') },
                        seo: { score: category('seo') },
                    },
                    metrics: {
                        firstContentfulPaint: metric('first contentful paint'),
                        largestContentfulPaint: metric('largest contentful paint'),
                        totalBlockingTime: metric('total blocking time'),
                        cumulativeLayoutShift: metric('cumulative layout shift'),
                        speedIndex: metric('speed index'),
                    },
                    capturedAt: lines.find((line) => /^(?:Captured at|Capturado)/i.test(line)) || null,
                    environment: lines.filter((line) =>
                        /Lighthouse|HeadlessChromium|4G|page load|carregamento/i.test(line)).slice(0, 20),
                    opportunities: savings.map((title) => ({ title })),
                    diagnostics: diagnostics.map((title) => ({ title })),
                    audits: audits.map((title, index) => ({
                        id: `web-ui-${index + 1}`,
                        title,
                    })),
                    rawText,
                };
            }, { requestedUrl: inspectedUrl.href, strategy });
        });
    }

    getSearchConsoleReports(property) { return this.getReports('search-console', { property }); }
    getSearchConsoleReport(options) { return this.getReport('search-console', options); }

    getIndexingPages({
        property,
        status = 'all',
        reason,
        urlContains,
        language,
        crawled,
        maxPages = 500,
    } = {}) {
        return this._runPageTask(async () => {
            if (!['all', 'indexed', 'not-indexed'].includes(status)) {
                throw new TypeError('status must be all, indexed or not-indexed');
            }
            if (status === 'indexed' && reason) throw new TypeError('reason only applies to not-indexed pages');
            if (language && !['pt', 'es'].includes(language)) throw new TypeError('language must be pt or es');
            if (crawled !== undefined && typeof crawled !== 'boolean') throw new TypeError('crawled must be a boolean');

            await this._openSearchConsole(SearchConsoleReports.indexing, property);
            const overview = await this._extractReport();
            const metric = (label) => Number(overview.metrics.find((item) => item.label === label)?.value || 0);
            const reasons = (overview.tables.find(({ headers }) => headers.some((header) => /reason/i.test(header)))?.rows || [])
                .map((row) => ({
                    reason: row[0],
                    count: Number([...row].reverse().find((value) => /^\d[\d,]*$/.test(value))?.replace(/,/g, '') || 0),
                }));
            const wantedReasons = reasons.filter((item) => item.count &&
                (!reason || item.reason.toLowerCase().includes(reason.toLowerCase())));
            const pages = [];
            const extraction = [];
            const collect = async (pageStatus, pageReason, expected) => {
                const report = await this._collectCurrentReport({ allPages: true, maxPages });
                const rows = report.tables.find(({ headers }) => headers.some((header) => /^url$/i.test(header)))?.rows || [];
                rows.forEach(([url, lastCrawled]) => pages.push({
                    url,
                    status: pageStatus,
                    reason: pageReason,
                    lastCrawled: !lastCrawled || /^(?:N\/A|1970-)/i.test(lastCrawled) ? null : lastCrawled,
                }));
                extraction.push({ status: pageStatus, reason: pageReason, expected, collected: rows.length });
            };

            if (status !== 'not-indexed' && !reason) {
                await this._openSearchConsole('index/drilldown?pages=ALL_URLS', property);
                await collect('indexed', null, metric('Indexed'));
            }
            if (status !== 'indexed') {
                for (const item of wantedReasons) {
                    await this._openSearchConsole(SearchConsoleReports.indexing, property);
                    if (!(await this._clickByLabel(item.reason, { exact: false, selector: 'tr, [role="row"]' }))) {
                        throw new Error(`Indexing reason is unavailable: ${item.reason}`);
                    }
                    await sleep(1000);
                    await collect('not-indexed', item.reason, item.count);
                }
            }

            const matchesLanguage = (url) => /^\/es(?:\/|$)/.test(new URL(url).pathname) === (language === 'es');
            const filtered = pages.filter((page) =>
                (!urlContains || page.url.toLowerCase().includes(urlContains.toLowerCase())) &&
                (!language || matchesLanguage(page.url)) &&
                (crawled === undefined || Boolean(page.lastCrawled) === crawled));
            return {
                generatedAt: new Date().toISOString(),
                property: overview.property,
                updated: overview.updated,
                complete: extraction.every((item) => item.collected === item.expected),
                filters: { status, reason: reason || null, urlContains: urlContains || null, language: language || null, crawled },
                summary: {
                    known: metric('Indexed') + metric('Not indexed'),
                    indexed: metric('Indexed'),
                    notIndexed: metric('Not indexed'),
                    returned: filtered.length,
                    byReason: reasons,
                },
                extraction,
                pages: filtered,
            };
        });
    }

    getLinks({ property, maxPages = 500 } = {}) {
        return this._runPageTask(async () => {
            await this._openSearchConsole(SearchConsoleReports.links, property);
            const summary = await this._extractReport();
            const drilldowns = summary.links.filter(({ url }) => {
                try {
                    return new URL(url).pathname === '/search-console/links/drilldown';
                } catch {
                    return false;
                }
            });
            const sections = [];
            for (const { url } of drilldowns) {
                const target = new URL(url);
                await this._openSearchConsole(`${target.pathname.replace('/search-console/', '')}${target.search}`, property);
                const report = await this._collectCurrentReport({ allPages: true, maxPages });
                sections.push({
                    type: target.searchParams.get('type'),
                    target: target.searchParams.get('target'),
                    domain: target.searchParams.get('domain'),
                    tables: report.tables,
                    paginations: report.paginations,
                    pagesRead: report.pagesRead,
                    complete: report.paginations.every(({ to, total }) => to === total),
                });
            }
            return {
                generatedAt: new Date().toISOString(),
                property: summary.property,
                summary,
                sections,
                complete: sections.every(({ complete }) => complete),
            };
        });
    }

    getPerformance({
        property,
        dimension = 'queries',
        period,
        startDate,
        endDate,
        filters = {},
        operators = {},
        allMetrics = true,
        allPages = false,
        maxPages = 50,
    } = {}) {
        return this._runPageTask(async () => {
            const dimensions = {
                queries: 'QUERIES',
                pages: 'PAGES',
                countries: 'COUNTRIES',
                devices: 'DEVICES',
                appearance: 'SEARCH APPEARANCE',
                days: 'DAYS',
            };
            if (!dimensions[dimension]) throw new TypeError(`Unknown performance dimension: ${dimension}`);
            await this._openSearchConsole(SearchConsoleReports.performance, property);
            if (period || startDate || endDate) await this._setPerformanceDate({ period, startDate, endDate });
            if (allMetrics) {
                await this._clickByLabel('Average CTR', { exact: false });
                await sleep(250);
                await this._clickByLabel('Average position', { exact: false });
                await sleep(700);
            }
            for (const [filter, value] of Object.entries(filters)) {
                if (value !== undefined && value !== '') {
                    await this._addPerformanceFilter(filter, String(value), operators[filter]);
                }
            }
            if (!(await this._clickByLabel(dimensions[dimension], { selector: '[role="tab"]' }))) {
                throw new Error(`Performance dimension is unavailable: ${dimension}`);
            }
            await sleep(1000);
            const result = await this._collectCurrentReport({ allPages, maxPages });
            result.dimension = dimension;
            if (dimension === 'days' && result.tables[0]) {
                const { headers, rows } = result.tables[0];
                result.series = rows.map((row) => Object.fromEntries(
                    row.map((value, index) => [headers[index] || `value_${index + 1}`, value]),
                ));
            }
            return result;
        });
    }

    async getPerformanceTimeGaps(options = {}) {
        const report = await this.getPerformance({ ...options, dimension: 'days', allPages: true });
        const parseDate = (value) => {
            const numeric = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
            if (numeric) {
                const year = Number(numeric[3]) + (numeric[3].length === 2 ? 2000 : 0);
                return Date.UTC(year, Number(numeric[1]) - 1, Number(numeric[2]));
            }
            const iso = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
            const named = String(value).match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
            const month = named && ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(named[1]);
            return named && month >= 0
                ? Date.UTC(Number(named[3]), month, Number(named[2]))
                : Date.parse(value);
        };
        const table = report.tables.find(({ rows }) => rows.some((row) => !Number.isNaN(parseDate(row[0]))));
        const dates = [...new Set((table?.rows || [])
            .map(([date]) => parseDate(date))
            .filter((date) => !Number.isNaN(date)))]
            .sort((a, b) => a - b);
        const gaps = dates.slice(1).flatMap((date, index) => {
            const previous = dates[index];
            const missing = Math.round((date - previous) / 86400000) - 1;
            return missing > 0 ? [{
                after: new Date(previous).toISOString().slice(0, 10),
                before: new Date(date).toISOString().slice(0, 10),
                missingDays: missing,
            }] : [];
        });
        return {
            property: report.property,
            range: dates.length ? {
                start: new Date(dates[0]).toISOString().slice(0, 10),
                end: new Date(dates.at(-1)).toISOString().slice(0, 10),
            } : null,
            observedDays: dates.length,
            gaps,
            complete: Boolean(dates.length) && gaps.length === 0,
            report,
        };
    }

    async getSearchConsoleSummary({ property, period = '28-days' } = {}) {
        const performance = await this.getPerformance({ property, period, dimension: 'queries' });
        property = performance.property;
        const indexing = await this.getSearchConsoleReport({ report: 'indexing', property });
        const sitemaps = await this.getSearchConsoleReport({ report: 'sitemaps', property });
        const coreWebVitals = await this.getSearchConsoleReport({ report: 'core-web-vitals', property });
        const manualActions = await this.getSearchConsoleReport({ report: 'manual-actions', property });
        const securityIssues = await this.getSearchConsoleReport({ report: 'security-issues', property });
        const notifications = await this.getNotifications({ property });
        return {
            generatedAt: new Date().toISOString(),
            property: performance.property,
            period,
            performance: {
                updated: performance.updated,
                metrics: performance.metrics,
                topQueries: performance.tables[0]?.rows || [],
            },
            indexing: {
                updated: indexing.updated,
                metrics: indexing.metrics,
                reasons: indexing.tables[0]?.rows || [],
            },
            sitemaps: sitemaps.tables[0]?.rows || [],
            coreWebVitals: coreWebVitals.rawText,
            manualActions: manualActions.rawText,
            securityIssues: securityIssues.rawText,
            notifications,
        };
    }

    getNotifications({ property } = {}) {
        return this._runPageTask(async () => {
            this._requirePage();
            const resource = this._searchConsoleProperty(property);
            if (this._serviceForUrl(this.pupPage.url()) !== 'search-console' ||
                new URL(this.pupPage.url()).searchParams.get('resource_id') !== resource) {
                await this._openSearchConsole(SearchConsoleReports.overview, resource);
            }
            const alreadyOpen = await this.pupPage.evaluate(() => /\d+ unread out of \d+/i.test(document.body?.innerText || ''));
            if (!alreadyOpen && !(await this._clickByLabel('Messages'))) {
                throw new Error('Search Console messages button is unavailable');
            }
            await sleep(700);
            const notifications = await this.pupPage.evaluate(() => {
                const text = document.body?.innerText || '';
                const summary = text.match(/(\d+) unread out of (\d+)/i);
                const items = [];
                const pattern = /([^\n]+)\n([A-Z][a-z]{2} \d{1,2}, \d{4})\n•\n([^\n]+)/g;
                for (const match of text.matchAll(pattern)) {
                    items.push({ title: match[1].trim(), date: match[2], category: match[3].trim() });
                }
                return {
                    unread: summary ? Number(summary[1]) : null,
                    total: summary ? Number(summary[2]) : items.length,
                    items,
                };
            });
            await this._clickByLabel('Close').catch(() => false);
            return { property: this._searchConsoleProperty(), ...notifications };
        });
    }

    inspectUrl(inspectedUrl, { property, action } = {}) {
        return this._runPageTask(async () => {
            let url;
            try {
                url = new URL(inspectedUrl);
            } catch {
                throw new TypeError('url must be a valid HTTP or HTTPS URL');
            }
            if (!['http:', 'https:'].includes(url.protocol)) {
                throw new TypeError('url must be a valid HTTP or HTTPS URL');
            }
            await this._openSearchConsole(SearchConsoleReports.overview, property);
            if (!(await this._clickByLabel('Search'))) throw new Error('URL inspection search is unavailable');
            await sleep(300);
            if (!(await this._typeByLabel('Inspect any URL', url.href, { submit: true }))) {
                throw new Error('URL inspection input is unavailable');
            }
            await this.pupPage.waitForFunction(
                () => location.pathname.includes('/inspect') && /URL Inspection/i.test(document.body?.innerText || ''),
                { timeout: 60000 },
            );
            await sleep(1200);
            if (action) {
                const actions = { live: 'TEST LIVE URL', index: 'Request indexing' };
                if (!actions[action]) throw new TypeError(`Unknown URL inspection action: ${action}`);
                if (!(await this._clickByLabel(actions[action], { exact: false }))) {
                    throw new Error(`URL inspection action is unavailable: ${action}`);
                }
                await sleep(1500);
            }
            return this._extractReport();
        });
    }

    submitSitemap(sitemap, { property } = {}) {
        return this._runPageTask(async () => {
            let url;
            try {
                url = new URL(sitemap);
            } catch {
                throw new TypeError('sitemap must be a valid HTTPS URL');
            }
            if (url.protocol !== 'https:') throw new TypeError('sitemap must be a valid HTTPS URL');
            await this._openSearchConsole(SearchConsoleReports.sitemaps, property);
            if (!(await this._typeByLabel('Enter sitemap URL', url.href))) {
                throw new Error('Sitemap input is unavailable');
            }
            await sleep(300);
            if (!(await this._clickByLabel('SUBMIT'))) throw new Error('Sitemap submit button is unavailable');
            await sleep(1500);
            return this._extractReport();
        });
    }

    controlSearchConsole(options) { return this.control('search-console', options); }

    click(elementId) {
        return this._runPageTask(async () => {
            const element = await this._element(elementId);
            if (!(await element.isVisible())) throw this._staleElement(elementId);
            try {
                await element.click();
            } catch {
                const connected = await element.evaluate((node) => node.isConnected);
                if (!connected) throw this._staleElement(elementId);
                await element.evaluate((node) => node.click());
            }
            await sleep(500);
            return this.getStatus();
        });
    }

    type(elementId, text, { submit = false } = {}) {
        return this._runPageTask(async () => {
            if (typeof text !== 'string' || typeof submit !== 'boolean') throw new TypeError('text must be a string; submit a boolean');
            const element = await this._element(elementId);
            const editable = await element.evaluate((node) =>
                (node.type !== 'password' && ['INPUT', 'TEXTAREA'].includes(node.tagName)) || node.isContentEditable,
            );
            if (!editable) throw new TypeError(`Element ${elementId} is not editable`);
            await element.click({ clickCount: 3 });
            await this.pupPage.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
            await this.pupPage.keyboard.press('A');
            await this.pupPage.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
            await this.pupPage.keyboard.press('Backspace');
            await this.pupPage.keyboard.type(text);
            if (submit) await this.pupPage.keyboard.press('Enter');
            await sleep(500);
            return this.getStatus();
        });
    }

    back() {
        return this._runPageTask(async () => {
            this._requirePage();
            await this.pupPage.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
            return this.getStatus();
        });
    }

    reload() {
        return this._runPageTask(async () => {
            this._requirePage();
            await this.pupPage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            return this.getStatus();
        });
    }

    screenshot({ fullPage = false } = {}) {
        return this._runPageTask(async () => {
            this._requirePage();
            if (typeof fullPage !== 'boolean') throw new TypeError('fullPage must be a boolean');
            return Buffer.from(await this.pupPage.screenshot({ type: 'png', fullPage }));
        });
    }

    async destroy() {
        await this._pageQueue;
        this._destroying = true;
        const browser = this.pupBrowser;
        const browserProcess = this._browserProcess;
        this.pupBrowser = null;
        this.pupPage = null;
        this._browserProcess = null;
        await this._closeBrowser(browser, browserProcess);
    }

    async resetSession() {
        await this.destroy();
        await this.authStrategy.logout();
        this._contexts = {};
        this._searchConsoleResource = this.options.searchConsoleProperty || null;
    }

    // ponytail: one shared tab; use per-service pages if parallel workflows become necessary.
    _runPageTask(task) {
        const result = this._pageQueue.then(task, task);
        this._pageQueue = result.catch(() => {});
        return result;
    }

    async _launchBrowser(options) {
        const systemChrome = process.platform === 'win32' && (options.executablePath || [
            process.env.ProgramFiles,
            process.env['ProgramFiles(x86)'],
            process.env.LOCALAPPDATA,
        ]
            .filter(Boolean)
            .map((base) => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
            .find((candidate) => fs.existsSync(candidate)));
        if (process.platform === 'win32' && !systemChrome) {
            throw new Error('Google Chrome is required for Google authentication on Windows');
        }
        if (process.platform !== 'win32' || options.headless !== false) {
            this.pupBrowser = await puppeteer.launch({
                ...options,
                ...(systemChrome ? { executablePath: systemChrome } : {}),
            });
            const pages = await this.pupBrowser.pages();
            await this._configureBrowser(pages);
            return;
        }

        const port = await new Promise((resolve, reject) => {
            const server = net.createServer();
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const { port } = server.address();
                server.close(() => resolve(port));
            });
        });
        if (!options.userDataDir) {
            throw new Error('Visible Google login requires a separate userDataDir');
        }
        this._browserProcess = spawn(
            systemChrome,
            [
                ...(options.args || []).filter((argument) =>
                    !argument.startsWith('--remote-debugging-') &&
                    !argument.startsWith('--user-data-dir='),
                ),
                `--user-data-dir=${options.userDataDir}`,
                `--remote-debugging-port=${port}`,
                '--no-first-run',
                '--no-default-browser-check',
                'about:blank',
            ],
            { detached: true, stdio: 'ignore', windowsHide: false },
        );
        this._browserProcess.unref();

        for (let attempt = 0; attempt < 100 && !this.pupBrowser; attempt++) {
            await sleep(100);
            const browser = await puppeteer.connect({
                browserURL: `http://127.0.0.1:${port}`,
                defaultViewport: options.defaultViewport,
            }).catch(() => null);
            if (!browser) continue;
            const pages = await browser.pages().catch(() => []);
            if (pages.length) {
                this.pupBrowser = browser;
                await this._configureBrowser(pages);
                return;
            }
            await browser.disconnect().catch(() => {});
        }
        this._browserProcess.kill();
        this._browserProcess = null;
        throw new Error('Visible Chromium failed to start');
    }

    async _configureBrowser(pages) {
        const browser = this.pupBrowser;
        this.pupPage = pages[0] || await browser.newPage();
        this.pupPage.setDefaultTimeout(30000);
        browser.on('disconnected', () => {
            if (this.pupBrowser !== browser) return;
            this.pupBrowser = null;
            this.pupPage = null;
            this._browserProcess = null;
            if (!this._destroying) this.emit(Events.DISCONNECTED);
        });
    }

    async _restartBrowser(options) {
        this._destroying = true;
        const browser = this.pupBrowser;
        const browserProcess = this._browserProcess;
        this.pupBrowser = null;
        this.pupPage = null;
        this._browserProcess = null;
        try {
            await this._closeBrowser(browser, browserProcess);
        } finally {
            this._destroying = false;
        }
        await this._launchBrowser(options);
    }

    async _closeBrowser(browser, browserProcess) {
        try {
            await browser?.close();
            if (browserProcess?.exitCode === null) {
                await Promise.race([once(browserProcess, 'exit'), sleep(5000)]);
            }
        } finally {
            if (browserProcess?.exitCode === null) browserProcess.kill();
        }
    }

    async _isAuthenticated() {
        if (!this.pupBrowser) return false;
        const cookies = await this.pupBrowser.defaultBrowserContext().cookies().catch(() => []);
        return cookies.some(({ name, domain }) => /(^|\.)google\.com$/.test(domain) && [
            'SID',
            'SAPISID',
            '__Secure-1PSID',
            '__Secure-3PSID',
        ].includes(name));
    }

    async _waitForAuthentication(service, loginUrl) {
        const started = Date.now();
        while (this.pupBrowser?.connected) {
            if (await this._isAuthenticated() && !this.pupPage.url().includes('accounts.google.com')) {
                await this.pupPage.goto(this._serviceUrl(service), {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000,
                });
                await sleep(1500);
                if (await this._isServiceAuthenticated(service)) return;
                await this.pupPage.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
            }
            if (this.options.authTimeoutMs && Date.now() - started >= this.options.authTimeoutMs) {
                throw new Error('Google login timed out');
            }
            await sleep(1000);
        }
        throw new Error('Login window was closed before authentication');
    }

    async _openSearchConsole(reportPath, property) {
        const resource = this._searchConsoleProperty(property);
        await this._openService('search-console', this._searchConsoleUrl(reportPath, resource));
        return resource;
    }

    _searchConsoleProperty(property) {
        let resource = property || this._searchConsoleResource;
        if (!resource && this.pupPage) {
            try {
                resource = new URL(this.pupPage.url()).searchParams.get('resource_id');
            } catch {}
        }
        if (typeof resource !== 'string' || !resource.trim() || resource.length > 500) {
            throw new TypeError('property is required, for example sc-domain:example.com');
        }
        this._searchConsoleResource = resource.trim();
        return this._searchConsoleResource;
    }

    _searchConsoleUrl(reportPath, property) {
        const url = new URL(this._serviceUrl('search-console', String(reportPath || '').replace(/^\/+/, '')));
        url.searchParams.set('resource_id', property);
        return url.href;
    }

    async _extractReport() {
        this._requirePage();
        const status = await this.getStatus();
        return {
            ...status,
            ...(status.service === 'search-console' && this._searchConsoleResource
                ? { property: this._searchConsoleResource } : {}),
            source: (status.service || 'browser') + '-web-ui',
            ...(await this.pupPage.evaluate(snapshot, { report: true, maxText: 100000, maxElements: 1000 })),
        };
    }

    async _collectCurrentReport({ allPages = false, maxPages = 50 } = {}) {
        if (typeof allPages !== 'boolean') throw new TypeError('allPages must be a boolean');
        if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
            throw new TypeError('maxPages must be an integer between 1 and 500');
        }
        const service = this._serviceForUrl(this.pupPage.url());
        await this._requireService(service);
        if (service === 'google-ads') {
            await this.pupPage.evaluate(() => document.querySelector('table, [role="grid"]:has([role="columnheader"]), material-table')?.scrollIntoView({ block: 'start' }));
            await sleep(400);
        }
        const report = await this._extractReport();
        const fromFirstPage = report.pagination?.from === 1;
        let pagesRead = 1;
        let signature = JSON.stringify([report.tables, report.paginations]);
        const nextPage = async () => {
            for (let attempt = 0; attempt < 5; attempt++) {
                const clicked = await this._clickNextPage();
                if (clicked !== null) return clicked;
                await sleep(400);
            }
            return false;
        };
        while (allPages && pagesRead < maxPages && await nextPage()) {
            await this._waitForPage();
            await this._requireService(service);
            let page = await this._extractReport();
            for (let attempt = 0; attempt < 5 && JSON.stringify([page.tables, page.paginations]) === signature; attempt++) {
                await sleep(400);
                page = await this._extractReport();
            }
            const nextSignature = JSON.stringify([page.tables, page.paginations]);
            if (nextSignature === signature) break;
            signature = nextSignature;
            page.tables.forEach((table, index) => {
                if (!report.tables[index]) return report.tables.push(table);
                const existing = new Set(report.tables[index].rows.map((row) => JSON.stringify(row)));
                table.rows.forEach((row) => {
                    const key = JSON.stringify(row);
                    if (existing.has(key)) return;
                    existing.add(key);
                    report.tables[index].rows.push(row);
                });
            });
            report.pagination = page.pagination;
            report.paginations = page.paginations;
            pagesRead++;
        }
        report.pagesRead = pagesRead;
        report.complete = report.paginations.some(({ to, total }) => to < total) ? false
            : fromFirstPage && report.tables.length === 1 && report.paginations.length === 1
                ? report.tables[0].rows.length === report.paginations[0].total : null;
        report.extraction = 'Rendered rows only; hidden or virtualized rows may be missing. null completeness means the UI supplied insufficient evidence.';
        return report;
    }

    async _clickNextPage() {
        for (const label of ['Next page', 'Go to next page', 'Go to the next page', 'Página seguinte', 'Ir para a página seguinte']) {
            if (await this._clickByLabel(label)) return true;
        }
        if (this._serviceForUrl(this.pupPage.url()) !== 'search-console') return false;
        return this.pupPage.evaluate(() => {
            const visible = (element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
            };
            const counters = [...document.querySelectorAll('*')].filter((element) =>
                element.children.length === 0 && visible(element) &&
                /^\d[\d,]*\s*[-–]\s*\d[\d,]*\s+(?:of|de)\s+\d[\d,]*$/i.test(element.textContent.trim()));
            const counter = counters.find((element) => {
                const [, to, total] = element.textContent.match(/\d[\d,]*\s*[-–]\s*(\d[\d,]*)\s+(?:of|de)\s+(\d[\d,]*)/i) || [];
                return Number(to?.replace(/,/g, '')) < Number(total?.replace(/,/g, ''));
            });
            if (!counter) return counters.length ? false : null;
            for (let container = counter.parentElement, depth = 0; container && depth < 5; container = container.parentElement, depth++) {
                const right = [...container.querySelectorAll('button, [role="button"], [jsaction], [tabindex]')]
                    .filter((element) => visible(element) && element.getBoundingClientRect().left > counter.getBoundingClientRect().right)
                    .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
                if (!right) continue;
                if (right.disabled || right.getAttribute('aria-disabled') === 'true' || right.getAttribute('tabindex') === '-1') return null;
                right.click();
                return true;
            }
            return null;
        });
    }

    async _setPerformanceDate({ period, startDate, endDate }) {
        const periods = {
            '24-hours': '24 hours',
            '7-days': '7 days',
            '28-days': '28 days',
            '3-months': '3 months',
            '6-months': 'Last 6 months',
            '12-months': 'Last 12 months',
            '16-months': 'Last 16 months',
            custom: 'Custom',
        };
        period = period || (startDate || endDate ? 'custom' : undefined);
        if (!periods[period]) throw new TypeError(`Unknown performance period: ${period}`);
        if (['24-hours', '7-days', '28-days', '3-months'].includes(period)) {
            if (!(await this._clickByLabel(periods[period]))) throw new Error(`Performance period is unavailable: ${period}`);
            await sleep(1000);
            return;
        }
        if (!(await this._clickByLabel('More time ranges'))) throw new Error('More time ranges is unavailable');
        await sleep(300);
        if (!(await this._clickByLabel(periods[period]))) throw new Error(`Performance period is unavailable: ${period}`);
        if (period === 'custom') {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) {
                throw new TypeError('custom period requires startDate and endDate in YYYY-MM-DD format');
            }
            const changed = await this.pupPage.evaluate(({ startDate, endDate }) => {
                const visible = (element) => {
                    const style = getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
                };
                const inputs = [...document.querySelectorAll('input[type="text"]')].filter(visible).slice(-2);
                if (inputs.length !== 2) return false;
                const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                [startDate, endDate].forEach((value, index) => {
                    set.call(inputs[index], value);
                    inputs[index].dispatchEvent(new Event('input', { bubbles: true }));
                    inputs[index].dispatchEvent(new Event('change', { bubbles: true }));
                });
                return true;
            }, { startDate, endDate });
            if (!changed) throw new Error('Custom date inputs are unavailable');
        }
        await sleep(200);
        if (!(await this._clickByLabel('Apply'))) throw new Error('Date range could not be applied');
        await sleep(1200);
    }

    async _addPerformanceFilter(filter, value, operator = 'contains') {
        const filters = {
            query: 'Query',
            page: 'Page',
            country: 'Country',
            device: 'Device',
            appearance: 'Search appearance',
        };
        if (!filters[filter]) throw new TypeError(`Unknown performance filter: ${filter}`);
        if (!(await this._clickByLabel('Add filter', { exact: false }))) throw new Error('Add filter is unavailable');
        await sleep(250);
        if (!(await this._clickByLabel(filters[filter]))) throw new Error(`Performance filter is unavailable: ${filter}`);
        await sleep(300);
        if (filter === 'query' || filter === 'page') {
            const operators = {
                contains: null,
                'not-contains': filter === 'query' ? 'Queries not containing' : 'URLs not containing',
                exact: filter === 'query' ? 'Exact query' : 'Exact URL',
                regex: 'Custom (regex)',
            };
            if (!(operator in operators)) throw new TypeError(`Unknown performance filter operator: ${operator}`);
            if (operators[operator]) {
                if (!(await this._clickByLabel('String matching options dropdown menu'))) {
                    throw new Error('String matching options are unavailable');
                }
                await sleep(200);
                if (!(await this._clickByLabel(operators[operator], {
                    selector: '[role="option"], [role="menuitem"], li',
                }))) throw new Error(`Performance filter operator is unavailable: ${operator}`);
            }
            const changed = await this.pupPage.evaluate((text) => {
                const visible = (element) => {
                    const style = getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
                };
                const input = [...document.querySelectorAll('input[type="text"]')].filter(visible).at(-1);
                if (!input) return false;
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
                input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }, value);
            if (!changed) throw new Error(`Performance ${filter} input is unavailable`);
        } else if (!(await this._clickByLabel(value))) {
            throw new TypeError(`No ${filter} option matches: ${value}`);
        }
        await sleep(200);
        if (!(await this._clickByLabel('Apply'))) throw new Error(`Performance ${filter} filter could not be applied`);
        await sleep(1000);
    }

    async _clickByLabel(label, { exact = true, selector, unique = false } = {}) {
        this._requirePage();
        return this.pupPage.evaluate(({ label, exact, selector, unique }) => {
            const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            const visible = (element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
            };
            const labelFor = (element) => clean(
                element.getAttribute('aria-label') ||
                (element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.innerText) ||
                element.innerText || element.textContent,
            );
            const wanted = clean(label).toLowerCase();
            const matches = [...document.querySelectorAll(selector || [
                'button',
                'a[href]',
                'input[type="radio"]',
                'input[type="checkbox"]',
                'tr',
                '[role="button"]',
                '[role="row"]',
                '[role="tab"]',
                '[role="menuitem"]',
                '[role="option"]',
                '[role="radio"]',
                '[role="checkbox"]',
            ].join(','))].filter((candidate) => {
                const actual = labelFor(candidate).toLowerCase();
                return visible(candidate) &&
                    !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true' &&
                    (exact ? actual === wanted : actual.includes(wanted));
            });
            if (unique && matches.length > 1) throw new TypeError(`Ambiguous control label: ${label}; use an ID from /browser/state`);
            if (!matches.length) return false;
            matches[0].click();
            return true;
        }, { label, exact, selector, unique });
    }

    async _typeByLabel(label, text, { submit = false, exact = false, unique = false } = {}) {
        this._requirePage();
        const changed = await this.pupPage.evaluate(({ label, text, exact, unique }) => {
            const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            const visible = (element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
            };
            const wanted = clean(label).toLowerCase();
            const matches = [...document.querySelectorAll('input:not([type="password"]), textarea, [role="textbox"], [contenteditable="true"]')]
                .filter((candidate) => {
                    const actual = clean(
                        candidate.getAttribute('aria-label') ||
                        (candidate.id && document.querySelector(`label[for="${CSS.escape(candidate.id)}"]`)?.innerText) ||
                        candidate.getAttribute('placeholder'),
                    ).toLowerCase();
                    return visible(candidate) && !candidate.disabled && !candidate.readOnly &&
                        candidate.getAttribute('aria-disabled') !== 'true' &&
                        candidate.getAttribute('type') !== 'password' && (exact ? actual === wanted : actual.includes(wanted));
                });
            if (unique && matches.length > 1) throw new TypeError(`Ambiguous field label: ${label}; use an ID from /browser/state`);
            const element = matches[0];
            if (!element) return false;
            element.focus();
            if ('value' in element) {
                const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
            } else {
                element.textContent = text;
            }
            element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }, { label, text, exact, unique });
        if (changed && submit) await this.pupPage.keyboard.press('Enter');
        return changed;
    }

    async _isServiceAuthenticated(service) {
        if (!Object.hasOwn(Services, service) || !this.pupPage || this._serviceForUrl(this.pupPage.url()) !== service) return false;
        if (!Services[service].login) return true;
        if (service === 'search-console') return this._isSearchConsoleAuthenticated();
        return this._isAuthenticated();
    }

    async _isSearchConsoleAuthenticated() {
        if (!this.pupPage || !(await this._isAuthenticated())) return false;
        let url;
        try {
            url = new URL(this.pupPage.url());
        } catch {
            return false;
        }
        if (
            url.hostname !== 'search.google.com' ||
            !url.pathname.startsWith('/search-console') ||
            url.pathname.startsWith('/search-console/about')
        ) {
            return false;
        }
        return this.pupPage.evaluate(() => {
            if (document.querySelector([
                '[aria-label*="Google Account"]',
                '[aria-label*="Conta Google"]',
                'a[href*="SignOutOptions"]',
            ].join(','))) return true;
            const text = (document.body?.innerText || '').toLowerCase();
            return [
                'overview',
                'vista geral',
                'performance',
                'desempenho',
                'url inspection',
                'inspeção do url',
                'indexing',
                'indexação',
            ].some((marker) => text.includes(marker));
        });
    }

    _requirePage() {
        if (!this.pupPage) {
            const error = new Error('Browser is not running');
            error.status = 409;
            throw error;
        }
    }

    async _element(elementId) {
        this._requirePage();
        if (!/^e\d+$/.test(String(elementId))) throw new TypeError('Invalid element id');
        return await this.pupPage.$(`[data-gtm-id="${elementId}"]`) ||
            Promise.reject(this._staleElement(elementId));
    }

    _staleElement(elementId) {
        const error = new Error(`Element ${elementId} is no longer available; request /browser/state again`);
        error.status = 409;
        return error;
    }

    _serviceForUrl(target) {
        let url;
        try { url = new URL(target); } catch { return null; }
        if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
        return Object.entries(Services).find(([, config]) => {
            const base = new URL(config.url);
            return url.hostname === base.hostname && (config.paths || [base.pathname]).some((path) => {
                const prefix = path.replace(/\/$/, '');
                return url.pathname === prefix || url.pathname.startsWith(prefix + '/');
            });
        })?.[0] || null;
    }

}

module.exports = Client;
