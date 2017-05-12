const http = require('http');
const https = require('https');
const zlib = require('zlib');
const querystring = require('querystring');

module.exports = (options) => {
    options = Object.assign({
        protocol: 'https:'
    }, options);

    if ('pathname' in options && !('path' in options)) {
        if ('query' in options) {
            options.path = `${options.pathname}?${querystring.stringify(options.query)}`;
        } else {
            options.path = options.pathname;
        }
    }

    const httpModule = options.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = httpModule.request(options, (response) => {
            let bodyStream;
            const chunks = [];
            const encoding = response.headers && response.headers['content-encoding'];
            if (encoding === 'gzip' || encoding === 'deflate') {
                response.on('error', reject);
                bodyStream = response.pipe(zlib.createUnzip());
            } else {
                bodyStream = response;
            }
            bodyStream.on('error', reject);
            bodyStream.on('data', (chunk) => {
                chunks.push(chunk);
            });
            bodyStream.on('end', () => {
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
