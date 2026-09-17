'use strict';

module.exports = {
    Client: require('./src/Client'),
    LocalAuth: require('./src/authStrategies/LocalAuth'),
    Services: require('./src/Constants').Services,
    SearchConsoleReports: require('./src/Constants').SearchConsoleReports,
    GoogleAdsReports: require('./src/Constants').GoogleAdsReports,
    Events: require('./src/Constants').Events,
    version: require('./package.json').version,
};
