'use strict';

process.env.NODE_ENV = 'development';
process.env.DEV_BYPASS_AUTH = 'true';
process.env.TRUST_PROXY = 'true';

require('./index.js');
