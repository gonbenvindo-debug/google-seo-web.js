'use strict';

const { spawn } = require('child_process');
const { EventEmitter, once } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const puppeteer = require('puppeteer');
const LocalAuth = require('./authStrategies/LocalAuth');
const { AllowedHosts, Events, LoginURL, Services } = require('./Constants');

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
