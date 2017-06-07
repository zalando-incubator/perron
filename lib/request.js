'use strict';

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
        let hasRequestEnded = false;
        let startTime;
        let timings;
        if (options.timing) {
            startTime = Date.now();
            timings = {};
        }
        const request = httpModule.request(options, (response) => {
            if (options.timing) {
                if (timings.lookup === undefined) {
                    timings.lookup = timings.socket;
                }
                if (timings.connect === undefined) {
                    timings.connect = timings.socket;
                }
                timings.response = Date.now() - startTime;
            }
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
                hasRequestEnded = true;
                if (options.timing) {
                    timings.end = Date.now() - startTime;
                    response.timingStart = startTime;
                    response.timings = timings;
                    response.timingPhases = {
                        wait: timings.socket,
                        dns: timings.lookup - timings.socket,
                        tcp: timings.connect - timings.lookup,
                        firstByte: timings.response - timings.connect,
                        download: timings.end - timings.response,
                        total: timings.end
                    };
                }
                resolve(response);
            });
        });
        if (options.timing) {
            request.once('socket', (socket) => {
                timings.socket = Date.now() - startTime;
                if (socket.connecting) {
                    const onLookUp = () => {
                        timings.lookup = Date.now() - startTime;
                    };
                    const onConnect = () => {
                        timings.connect = Date.now() - startTime;
                    };
                    socket.once('lookup', onLookUp);
                    socket.once('connect', onConnect);
                    request.once('error', () => {
                        socket.removeListener('lookup', onLookUp);
                        socket.removeListener('connect', onConnect);
                    });
                } else {
                    timings.lookup = timings.socket;
                    timings.connect = timings.socket;
                }
            });
        }
        request.on('error', reject);
        request.on('timeout', () => {
            request.abort();
            reject(new Error('socket timeout'));
        });
        if (options.dropRequestAfter) {
            setTimeout(() => {
                if (!hasRequestEnded) {
                    request.abort();
                    reject(new Error('request timeout'));
                }
            }, options.dropRequestAfter);
        }
        if (options.body) {
            request.write(options.body);
        }
        request.end();
    });
};
