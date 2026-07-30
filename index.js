'use strict';

// Isang process lang para sa dalawa.
// Ang api/server.js ang bahala sa HTTP port.
// Ang bot/index.js ang bahala sa Discord gateway.

console.log('Starting combined service...');

require('./api/server');
require('./bot/index');

console.log('Both API and bot were started.');
