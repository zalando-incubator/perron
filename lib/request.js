const http = require('http');
const https = require('https');

module.exports = (options) => {
    options = Object.assign({
        protocol: 'https:'
    }, options);
    const httpModule = options.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const chunks = [];
        const request = httpModule.request(options, (response) => {
            response.on('data', (chunk) => {
                chunks.push(chunk);
            });
            response.on('end', () => {
                response.body = Buffer.concat(chunks).toString('utf8');
                resolve(response);
            });
        });
        request.on('error', reject);
        if (options.body) {
            request.write(options.body);
        }
        request.end();
    });
};
