const http = require('http');
const https = require('https');

module.exports = (options) => {
    options = Object.assign({
        protocol: 'https:'
    }, options);
    const httpModule = options.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = httpModule.request(options, (response) => {
            response.body = '';
            response.on('data', (chunk) => {
                response.body += chunk;
            });
            response.on('end', () => {
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
