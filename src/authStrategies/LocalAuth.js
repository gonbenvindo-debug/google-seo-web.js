'use strict';

const fs = require('fs');
const path = require('path');
const BaseAuthStrategy = require('./BaseAuthStrategy');

class LocalAuth extends BaseAuthStrategy {
    constructor({ clientId, dataPath = './.google-seo-auth' } = {}) {
        super();
        if (clientId && !/^[-_\w]+$/i.test(clientId)) {
            throw new Error('clientId accepts only letters, numbers, underscores and hyphens');
        }
        this.userDataDir = path.join(
            path.resolve(dataPath),
            clientId ? `session-${clientId}` : 'session',
        );
    }

    async beforeBrowserInitialized() {
        const configured = this.client.options.puppeteer.userDataDir;
        if (configured && path.resolve(configured) !== this.userDataDir) {
            throw new Error('LocalAuth cannot be combined with puppeteer.userDataDir');
        }
        await fs.promises.mkdir(this.userDataDir, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') await fs.promises.chmod(this.userDataDir, 0o700);
        this.client.options.puppeteer.userDataDir = this.userDataDir;
    }

    async logout() {
        await fs.promises.rm(this.userDataDir, { recursive: true, force: true, maxRetries: 4 });
    }
}

module.exports = LocalAuth;

