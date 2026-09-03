'use strict';

module.exports = {
    Client: require('./src/Client'),
    LocalAuth: require('./src/authStrategies/LocalAuth'),
    Services: require('./src/Constants').Services,
    Events: require('./src/Constants').Events,
    version: require('./package.json').version,
};

