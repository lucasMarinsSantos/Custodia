// Ambiente de testes: Web Crypto do Node para getRandomValues
const { webcrypto } = require('crypto');
if (!global.crypto) global.crypto = webcrypto;
if (!global.crypto.getRandomValues) global.crypto.getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
