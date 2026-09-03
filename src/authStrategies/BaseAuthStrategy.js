'use strict';

class BaseAuthStrategy {
    setup(client) {
        this.client = client;
    }

    async beforeBrowserInitialized() {}

    async logout() {}
}

module.exports = BaseAuthStrategy;

