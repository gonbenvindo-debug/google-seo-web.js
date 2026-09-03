'use strict';

const { spawn } = require('child_process');
const { EventEmitter, once } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const puppeteer = require('puppeteer');
const LocalAuth = require('./authStrategies/LocalAuth');
const {
    AllowedHosts,
    Events,
    LoginURL,
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
        if (!Services[this.options.defaultService]) throw new TypeError('Unknown default service');
        this.authStrategy = options.authStrategy || new LocalAuth();
        this.authStrategy.setup(this);
        this.pupBrowser = null;
        this.pupPage = null;
        this._browserProcess = null;
        this._destroying = false;
        this._pageQueue = Promise.resolve();
        this._searchConsoleResource = options.searchConsoleProperty || null;
    }

    async initialize(target = this.options.defaultService) {
        if (this.pupBrowser) throw new Error('Client is already initialized');
        this._destroying = false;
        try {
            await this.authStrategy.beforeBrowserInitialized();
            await this._launchBrowser({ ...this.options.puppeteer, headless: true });
            await this.pupPage.goto(Services['search-console'].url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });
            await sleep(1000);

            let visibleLogin = false;
            if (!(await this._isSearchConsoleAuthenticated())) {
                if (this.options.puppeteer.headless === false) {
                    await this._restartBrowser(this.options.puppeteer);
                    visibleLogin = true;
                }
                this.emit(Events.LOGIN_REQUIRED, { url: LoginURL });
                await this.pupPage.goto(LoginURL, { waitUntil: 'domcontentloaded', timeout: 0 });
                try {
                    await this._waitForAuthentication();
                } catch (error) {
                    this.emit(Events.AUTHENTICATION_FAILURE, error.message);
                    throw error;
                }

                if (visibleLogin) {
                    await this.pupPage.setContent(`<!doctype html>
                        <html lang="pt"><meta charset="utf-8"><title>Google autenticado</title>
                        <style>
                            body { margin: 0; min-height: 100vh; display: grid; place-items: center;
                                font: 16px system-ui; color: #171717; background: #fff; text-align: center; }
                            b { display: grid; place-items: center; width: 52px; height: 52px; margin: auto;
                                border-radius: 50%; color: #fff; background: #16a34a; font-size: 28px; }
                            h1 { margin: 18px 0 8px; font-size: 22px; }
                            p { margin: 0; color: #666; }
                        </style><main><b>✓</b><h1>Autenticação concluída</h1>
                        <p>A janela vai fechar automaticamente.</p></main></html>`);
                    await sleep(1500);
                }
            } else if (!this.options.headlessAfterLogin && this.options.puppeteer.headless === false) {
                await this._restartBrowser(this.options.puppeteer);
            }

            if (visibleLogin && this.options.headlessAfterLogin) {
                await this._restartHeadless();
                await this.pupPage.goto(Services['search-console'].url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000,
                });
                await sleep(1000);
                if (!(await this._isSearchConsoleAuthenticated())) {
                    throw new Error('Google session was not persisted after login');
                }
            }
            this.emit(Events.AUTHENTICATED);
            await this.open(target);
            this.emit(Events.READY, await this.getStatus());
            return this;
        } catch (error) {
            await this.destroy().catch(() => {});
            throw error;
        }
    }

    resolveTarget(target = this.options.defaultService) {
        if (Services[target]) return { service: target, url: Services[target].url };

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
        try {
            const resource = new URL(url).searchParams.get('resource_id');
            if (resource) this._searchConsoleResource = resource;
        } catch {}
        const hasGoogleSession = await this._isAuthenticated();
        return {
            running: true,
            service: this._serviceForUrl(url),
            url,
            title: await this.pupPage.title(),
            googleSession: url.includes('accounts.google.com') || url.includes('/search-console/about')
                ? 'required'
                : hasGoogleSession ? 'present' : 'unknown',
        };
    }

    async getState({ maxText = 30000, maxElements = 250 } = {}) {
        this._requirePage();
        if (!Number.isInteger(maxText) || maxText < 1000 || maxText > 100000) {
            throw new TypeError('maxText must be an integer between 1000 and 100000');
        }
        if (!Number.isInteger(maxElements) || maxElements < 1 || maxElements > 1000) {
            throw new TypeError('maxElements must be an integer between 1 and 1000');
        }

        const page = await this.pupPage.evaluate(({ maxText, maxElements }) => {
            const root = document.documentElement;
            let counter = Number(root.dataset.googleSeoElementCounter || 0);
            const clean = (value, limit = 500) => String(value || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, limit);
            const visible = (element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
            };
            const labelFor = (element) => {
                const explicit = element.id
                    ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.innerText
                    : '';
                return clean(
                    element.getAttribute('aria-label') ||
                    explicit ||
                    element.getAttribute('placeholder') ||
                    element.innerText ||
                    element.textContent,
                );
            };
            const elements = [...document.querySelectorAll([
                'a[href]',
                'button',
                'input',
                'textarea',
                'select',
                '[role="button"]',
                '[role="link"]',
                '[role="textbox"]',
                '[role="combobox"]',
                '[role="tab"]',
                '[role="menuitem"]',
            ].join(','))]
                .filter(visible)
                .slice(0, maxElements)
                .map((element) => {
                    let id = element.getAttribute('data-google-seo-id');
                    if (!id) {
                        id = `e${++counter}`;
                        element.setAttribute('data-google-seo-id', id);
                    }
                    const type = element.getAttribute('type') || undefined;
                    const value = 'value' in element && type !== 'password'
                        ? clean(element.value)
                        : undefined;
                    return {
                        id,
                        tag: element.tagName.toLowerCase(),
                        role: element.getAttribute('role') || undefined,
                        type,
                        label: labelFor(element),
                        href: element.href || undefined,
                        value,
                        disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
                    };
                });
            root.dataset.googleSeoElementCounter = String(counter);
            const bodyText = String(document.body?.innerText || '')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
                .slice(0, maxText);
            const headings = [...document.querySelectorAll('h1, h2, h3, [role="heading"]')]
                .filter(visible)
                .map((element) => clean(element.innerText || element.textContent))
                .filter(Boolean)
                .slice(0, 100);
            const visuals = [...document.querySelectorAll('canvas, svg, [role="img"]')]
                .filter(visible)
                .map((element) => ({
                    tag: element.tagName.toLowerCase(),
                    label: clean(element.getAttribute('aria-label') || element.getAttribute('title')),
                }))
                .filter(({ label }) => label)
                .slice(0, 100);
            return { bodyText, headings, elements, visuals };
        }, { maxText, maxElements });

        return { ...(await this.getStatus()), ...page };
    }

    async getPageSpeedReport(target, {
        strategy = 'mobile',
        categories = ['performance', 'accessibility', 'best-practices', 'seo'],
        locale = 'en',
        apiKey,
        raw = false,
    } = {}) {
        let inspectedUrl;
        try {
            inspectedUrl = new URL(target);
        } catch {
            throw new TypeError('url must be a valid HTTP or HTTPS URL');
        }
        if (!['http:', 'https:'].includes(inspectedUrl.protocol)) {
            throw new TypeError('url must be a valid HTTP or HTTPS URL');
        }
        if (!['mobile', 'desktop'].includes(strategy)) throw new TypeError('strategy must be mobile or desktop');
        const allowedCategories = new Set(['performance', 'accessibility', 'best-practices', 'seo']);
        if (!Array.isArray(categories) || !categories.length || categories.some((category) => !allowedCategories.has(category))) {
            throw new TypeError('category must be performance, accessibility, best-practices or seo');
        }
        const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
        endpoint.searchParams.set('url', inspectedUrl.href);
        endpoint.searchParams.set('strategy', strategy);
        endpoint.searchParams.set('locale', locale);
        [...new Set(categories)].forEach((category) => endpoint.searchParams.append('category', category));
        if (apiKey) endpoint.searchParams.set('key', apiKey);
        const response = await fetch(endpoint);
        const data = await response.json();
        if (!response.ok) {
            const error = new Error(data.error?.message || `PageSpeed API returned HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        const lighthouse = data.lighthouseResult || {};
        const audits = Object.entries(lighthouse.audits || {}).map(([id, audit]) => ({
            id,
            title: audit.title,
            description: audit.description,
            score: audit.score,
            scoreDisplayMode: audit.scoreDisplayMode,
            displayValue: audit.displayValue,
            numericValue: audit.numericValue,
            numericUnit: audit.numericUnit,
            metricSavings: audit.metricSavings,
            warnings: audit.warnings,
            details: audit.details,
        }));
        return {
            source: 'api',
            requestedUrl: inspectedUrl.href,
            finalUrl: lighthouse.finalDisplayedUrl || lighthouse.finalUrl || data.id,
            strategy,
            fetchedAt: lighthouse.fetchTime,
            lighthouseVersion: lighthouse.lighthouseVersion,
            categories: Object.fromEntries(Object.entries(lighthouse.categories || {}).map(([id, category]) => [id, {
                title: category.title,
                score: category.score === null ? null : Math.round(category.score * 100),
                auditRefs: category.auditRefs,
            }])),
            fieldData: data.loadingExperience || null,
            originFieldData: data.originLoadingExperience || null,
            environment: lighthouse.environment,
            timing: lighthouse.timing,
            configSettings: lighthouse.configSettings,
            audits,
            opportunities: audits.filter((audit) =>
                audit.details?.type === 'opportunity' && audit.score !== null && audit.score < 1),
            diagnostics: audits.filter((audit) =>
                ['diagnostic', 'table', 'criticalrequestchain'].includes(audit.details?.type)),
            ...(raw ? { raw: data } : {}),
        };
    }

    getPageSpeedWebReport(target, { strategy = 'mobile' } = {}) {
        return this._runPageTask(async () => {
            let inspectedUrl;
            try {
                inspectedUrl = new URL(target);
            } catch {
                throw new TypeError('url must be a valid HTTP or HTTPS URL');
            }
            if (!['http:', 'https:'].includes(inspectedUrl.protocol)) {
                throw new TypeError('url must be a valid HTTP or HTTPS URL');
            }
            if (!['mobile', 'desktop'].includes(strategy)) throw new TypeError('strategy must be mobile or desktop');
            const pageSpeedUrl = new URL('https://pagespeed.web.dev/analysis');
            pageSpeedUrl.searchParams.set('url', inspectedUrl.href);
            pageSpeedUrl.searchParams.set('form_factor', strategy);
            await this.pupPage.goto(pageSpeedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await this.pupPage.waitForFunction(() => {
                const text = document.body?.innerText || '';
                return /First Contentful Paint/i.test(text) && /Largest Contentful Paint/i.test(text);
            }, { timeout: 120000 });
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
                    const index = lines.findIndex((line) => names.some((name) => line.toLowerCase() === name));
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
                    source: 'web-ui-fallback',
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

    getSearchConsoleReports(property) {
        const resource = this._searchConsoleProperty(property);
        return Object.entries(SearchConsoleReports).map(([name, reportPath]) => ({
            name,
            url: this._searchConsoleUrl(reportPath, resource),
        }));
    }

    getSearchConsoleReport({
        report = 'overview',
        path: reportPath,
        property,
        tab,
        allPages = false,
        maxPages = 50,
    } = {}) {
        return this._runPageTask(async () => {
            const path = reportPath === undefined ? SearchConsoleReports[report] : reportPath;
            if (path === undefined) throw new TypeError(`Unknown Search Console report: ${report}`);
            await this._openSearchConsole(path, property);
            if (tab && !(await this._clickByLabel(tab, { selector: '[role="tab"]' }))) {
                throw new TypeError(`Unknown or unavailable report tab: ${tab}`);
            }
            if (tab) await sleep(1000);
            return this._collectCurrentReport({ allPages, maxPages });
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
        const indexing = await this.getSearchConsoleReport({ report: 'indexing', property });
        const sitemaps = await this.getSearchConsoleReport({ report: 'sitemaps', property });
        const coreWebVitals = await this.getSearchConsoleReport({ report: 'core-web-vitals', property });
        const manualActions = await this.getSearchConsoleReport({ report: 'manual-actions', property });
        const securityIssues = await this.getSearchConsoleReport({ report: 'security-issues', property });
        const notifications = await this.getNotifications();
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

    getNotifications() {
        return this._runPageTask(async () => {
            this._requirePage();
            if (!this.pupPage.url().startsWith('https://search.google.com/search-console')) {
                await this._openSearchConsole(SearchConsoleReports.overview);
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

    controlSearchConsole({ label, text, submit = false, exact = true } = {}) {
        return this._runPageTask(async () => {
            if (!label) throw new TypeError('label is required');
            const changed = text === undefined
                ? await this._clickByLabel(label, { exact })
                : await this._typeByLabel(label, String(text), { submit, exact });
            if (!changed) throw new TypeError(`No visible control matches label: ${label}`);
            await sleep(500);
            return this._extractReport();
        });
    }

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
            if (typeof text !== 'string') throw new TypeError('text must be a string');
            const element = await this._element(elementId);
            const editable = await element.evaluate((node) =>
                ['INPUT', 'TEXTAREA'].includes(node.tagName) || node.isContentEditable,
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

    async screenshot({ fullPage = false } = {}) {
        this._requirePage();
        return Buffer.from(await this.pupPage.screenshot({ type: 'png', fullPage }));
    }

    async destroy() {
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
    }

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
            await Promise.resolve(systemChrome),
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

    async _restartHeadless() {
        await this._restartBrowser({ ...this.options.puppeteer, headless: true });
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
        return cookies.some(({ name }) => [
            'SID',
            'SAPISID',
            '__Secure-1PSID',
            '__Secure-3PSID',
        ].includes(name));
    }

    async _waitForAuthentication() {
        const started = Date.now();
        while (this.pupBrowser?.connected) {
            if (await this._isAuthenticated() && !this.pupPage.url().includes('accounts.google.com')) {
                await this.pupPage.goto(Services['search-console'].url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000,
                });
                await sleep(1500);
                if (await this._isSearchConsoleAuthenticated()) return;
                await this.pupPage.goto(LoginURL, { waitUntil: 'domcontentloaded', timeout: 0 });
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
        await this.pupPage.goto(this._searchConsoleUrl(reportPath, resource), {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await sleep(1200);
        if (!(await this._isSearchConsoleAuthenticated())) {
            throw new Error('An authenticated Search Console session is required');
        }
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
        const url = new URL(String(reportPath || '').replace(/^\/+/, ''), 'https://search.google.com/search-console/');
        if (url.hostname !== 'search.google.com' || !url.pathname.startsWith('/search-console')) {
            throw new TypeError('Search Console report path is invalid');
        }
        url.searchParams.set('resource_id', property);
        return url.href;
    }

    async _extractReport() {
        this._requirePage();
        const report = await this.pupPage.evaluate(() => {
            const clean = (value, limit = 5000) => String(value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
                .slice(0, limit);
            const visible = (element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
            };
            const labelFor = (element) => {
                const explicit = element.id
                    ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.innerText
                    : '';
                return clean(
                    element.getAttribute('aria-label') ||
                    explicit ||
                    element.getAttribute('placeholder') ||
                    element.innerText ||
                    element.textContent,
                );
            };
            const bodyText = clean(document.body?.innerText, 100000);
            let roots = [...document.querySelectorAll('table, [role="table"], [role="grid"]')]
                .filter(visible)
                .filter((root) => !root.parentElement?.closest('table, [role="table"], [role="grid"]'));
            if (!roots.length && document.querySelectorAll('[role="row"]').length > 1) roots = [document.body];
            const tables = roots.map((root) => {
                const rowElements = root.matches('table')
                    ? [...root.querySelectorAll('tr')]
                    : [...root.querySelectorAll('[role="row"]')];
                const headerRow = rowElements.find((row) => row.querySelector('th, [role="columnheader"]'));
                const rows = rowElements.filter((row) => visible(row) && row !== headerRow).map((row) => {
                    let cells = [...row.querySelectorAll([
                        ':scope > th',
                        ':scope > td',
                        ':scope > [role="columnheader"]',
                        ':scope > [role="rowheader"]',
                        ':scope > [role="gridcell"]',
                        ':scope > [role="cell"]',
                    ].join(','))].filter(visible);
                    if (!cells.length) {
                        cells = [...row.children].filter((child) => visible(child) && clean(child.innerText));
                    }
                    return cells.map((cell) => clean(cell.innerText || cell.textContent)).filter(Boolean);
                }).filter((row) => row.length);
                const headers = headerRow
                    ? [...headerRow.querySelectorAll('th, [role="columnheader"]')].map((cell) => clean(cell.innerText)).filter(Boolean)
                    : [];
                return {
                    name: clean(root.getAttribute('aria-label') || root.querySelector('caption')?.innerText),
                    headers,
                    rows,
                };
            }).filter(({ rows }) => rows.length);
            const controls = [...document.querySelectorAll([
                'button',
                'input',
                'select',
                '[role="button"]',
                '[role="radio"]',
                '[role="tab"]',
                '[role="combobox"]',
                '[role="menuitem"]',
            ].join(','))]
                .filter(visible)
                .map((element) => ({
                    label: labelFor(element),
                    role: element.getAttribute('role') || element.tagName.toLowerCase(),
                    value: 'value' in element && element.type !== 'password' ? clean(element.value) : undefined,
                    selected: element.getAttribute('aria-selected') === 'true' ||
                        element.getAttribute('aria-checked') === 'true' ||
                        element.getAttribute('aria-pressed') === 'true' || Boolean(element.checked),
                    disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
                }))
                .filter(({ label }) => label)
                .slice(0, 1000);
            const metrics = controls.flatMap(({ label }) => {
                const lines = label.split('\n').map((line) => clean(line)).filter(Boolean);
                const valueIndex = lines.findIndex((line, index) => index > 0 &&
                    /^(?:[<>]?\d[\d.,]*[KMB]?%?|No data)$/i.test(line));
                if (valueIndex < 1) return [];
                return [{
                    label: lines[valueIndex - 1],
                    value: lines[valueIndex],
                    details: lines.slice(valueIndex + 1),
                }];
            }).filter(({ label }, index, values) =>
                !values.slice(0, index).some((metric) => metric.label === label));
            const chartDescriptions = [...bodyText.matchAll(/Chart,[^\n]+/gi)].map(([text]) => clean(text));
            const charts = [...document.querySelectorAll('canvas, svg, [role="img"]')]
                .filter(visible)
                .map((element) => ({
                    type: element.tagName.toLowerCase(),
                    description: clean(element.getAttribute('aria-label') || element.getAttribute('title')),
                    labels: element.matches('svg')
                        ? [...element.querySelectorAll('text')].map((text) => clean(text.textContent)).filter(Boolean).slice(0, 500)
                        : [],
                }))
                .filter(({ description, labels }) => description || labels.length);
            chartDescriptions.forEach((description) => {
                if (!charts.some((chart) => chart.description === description)) charts.push({ type: 'accessible-text', description, labels: [] });
            });
            const pagination = bodyText.match(/(\d[\d,]*)-(\d[\d,]*) of (\d[\d,]*)/i);
            return {
                updated: bodyText.match(/Last update(?:d)?:\s*([^\n]+)/i)?.[1] || null,
                headings: [...document.querySelectorAll('h1, h2, h3, [role="heading"]')]
                    .filter(visible).map((element) => clean(element.innerText)).filter(Boolean).slice(0, 100),
                metrics,
                controls,
                tables,
                charts,
                pagination: pagination ? {
                    from: Number(pagination[1].replace(/,/g, '')),
                    to: Number(pagination[2].replace(/,/g, '')),
                    total: Number(pagination[3].replace(/,/g, '')),
                } : null,
                links: [...document.querySelectorAll('a[href]')].filter(visible).map((link) => ({
                    label: labelFor(link),
                    url: link.href,
                })).filter(({ label }) => label).slice(0, 500),
                rawText: bodyText,
            };
        });
        return {
            ...(await this.getStatus()),
            property: this._searchConsoleProperty(),
            ...report,
        };
    }

    async _collectCurrentReport({ allPages = false, maxPages = 50 } = {}) {
        if (typeof allPages !== 'boolean') throw new TypeError('allPages must be a boolean');
        if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
            throw new TypeError('maxPages must be an integer between 1 and 500');
        }
        const report = await this._extractReport();
        let pagesRead = 1;
        while (allPages && pagesRead < maxPages && await this._clickByLabel('Next page')) {
            await sleep(800);
            const page = await this._extractReport();
            page.tables.forEach((table, index) => {
                if (!report.tables[index]) return report.tables.push(table);
                const existing = new Set(report.tables[index].rows.map((row) => JSON.stringify(row)));
                table.rows.forEach((row) => {
                    if (!existing.has(JSON.stringify(row))) report.tables[index].rows.push(row);
                });
            });
            report.pagination = page.pagination;
            pagesRead++;
        }
        report.pagesRead = pagesRead;
        return report;
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

    async _clickByLabel(label, { exact = true, selector } = {}) {
        this._requirePage();
        return this.pupPage.evaluate(({ label, exact, selector }) => {
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
            const element = [...document.querySelectorAll(selector || [
                'button',
                'a[href]',
                'input[type="radio"]',
                'tr',
                '[role="button"]',
                '[role="row"]',
                '[role="tab"]',
                '[role="menuitem"]',
                '[role="option"]',
            ].join(','))].find((candidate) => {
                const actual = labelFor(candidate).toLowerCase();
                return visible(candidate) &&
                    !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true' &&
                    (exact ? actual === wanted : actual.includes(wanted));
            });
            if (!element) return false;
            element.click();
            return true;
        }, { label, exact, selector });
    }

    async _typeByLabel(label, text, { submit = false, exact = false } = {}) {
        this._requirePage();
        const changed = await this.pupPage.evaluate(({ label, text, exact }) => {
            const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            const visible = (element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
            };
            const wanted = clean(label).toLowerCase();
            const element = [...document.querySelectorAll('input, textarea, [role="textbox"], [contenteditable="true"]')]
                .find((candidate) => {
                    const actual = clean(
                        candidate.getAttribute('aria-label') ||
                        (candidate.id && document.querySelector(`label[for="${CSS.escape(candidate.id)}"]`)?.innerText) ||
                        candidate.getAttribute('placeholder'),
                    ).toLowerCase();
                    return visible(candidate) && !candidate.disabled && (exact ? actual === wanted : actual.includes(wanted));
                });
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
        }, { label, text, exact });
        if (changed && submit) await this.pupPage.keyboard.press('Enter');
        return changed;
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
        return await this.pupPage.$(`[data-google-seo-id="${elementId}"]`) ||
            Promise.reject(this._staleElement(elementId));
    }

    _staleElement(elementId) {
        const error = new Error(`Element ${elementId} is no longer available; request /browser/state again`);
        error.status = 409;
        return error;
    }

    _serviceForUrl(url) {
        return Object.entries(Services)
            .find(([, service]) => {
                const prefix = service.url.replace(/\/$/, '');
                return url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`);
            })?.[0] || null;
    }
}

module.exports = Client;
