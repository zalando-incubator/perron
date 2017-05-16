'use strict';

const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const EventEmitter = require('events');
const zlib = require('zlib');
const stream = require('stream');

class ResponseStub extends EventEmitter {}
class RequestStub extends EventEmitter {
    end() {}
}
class BufferStream extends stream.Readable {
    constructor(buffer) {
        super();
        this.index = 0;
        this.buffer = buffer;
    }
    _read() {
        if (this.index >= this.buffer.length) {
            this.push(null);
            return;
        }
        this.push(this.buffer.slice(this.index, this.index + 1));
        this.index += 1;
    }
}

describe('request', () => {

    const httpStub = {};
    const httpsStub = {};

    let request = proxyquire('../lib/request', {
        http: httpStub,
        https: httpsStub
    });
    let requestStub;

    beforeEach(() => {
        httpStub.request = sinon.stub();
        httpsStub.request = sinon.stub();
        requestStub = new RequestStub();
        httpsStub.request.returns(requestStub);
    });

    it('should call https if protocol is not specified', () => {
        request();
        assert.equal(httpsStub.request.callCount, 1);
    });

    it('should allow to call http if it is specified as protocol', () => {
        httpsStub.request.returns(undefined);
        httpStub.request.returns(requestStub);
        request({ protocol: 'http:' });
        assert.equal(httpStub.request.callCount, 1);
    });

    it('should use pathname as path if none specified', () => {
        request({ pathname: '/foo' });
        assert.equal(httpsStub.request.firstCall.args[0].path, '/foo');
    });

    it('should prefer fully resolved path even if pathname is specified', () => {
        request({
            pathname: '/foo',
            path: '/bar'
        });
        assert.equal(httpsStub.request.firstCall.args[0].path, '/bar');
    });

    it('should allow to specify query params as an object', () => {
        request({
            query: {
                foo: 'bar',
                buz: 42
            },
            pathname: '/'
        });
        assert.equal(httpsStub.request.firstCall.args[0].path, '/?foo=bar&buz=42');
    });

    it('should return a promise', () => {
        assert(typeof request().then, 'function');
    });

    it('should reject a promise if request errors out', (done) => {
        request().catch(() => {
            done();
        });
        requestStub.emit('error');
    });

    it('should use the body of the request if one is provided', () => {
        requestStub.write = sinon.spy();
        request({
            body: 'foobar'
        });
        assert.equal(requestStub.write.firstCall.args[0], 'foobar');
    });

    it('should resolve the promise with full response on success', (done) => {
        request().then(response => {
            assert.equal(response.body, 'foobar');
            done();
        });
        const responseStub = new ResponseStub();
        httpsStub.request.firstCall.args[1](responseStub);
        responseStub.emit('data', Buffer.from('foo'));
        responseStub.emit('data', Buffer.from('bar'));
        responseStub.emit('end');
    });

    it('should reject the promise on response error', (done) => {
        request().catch(error => {
            assert.equal(error.message, 'test');
            done();
        });
        const responseStub = new ResponseStub();
        httpsStub.request.firstCall.args[1](responseStub);
        responseStub.emit('data', Buffer.from('foo'));
        responseStub.emit('error', new Error('test'));
    });

    it('should support responses chunked between utf8 boundaries', (done) => {
        request().then(response => {
            assert.equal(response.body, 'я');
            done();
        });
        const responseStub = new ResponseStub();
        httpsStub.request.firstCall.args[1](responseStub);
        const data = Buffer.from('я');
        responseStub.emit('data', Buffer.from([data[0]]));
        responseStub.emit('data', Buffer.from([data[1]]));
        responseStub.emit('end');
    });

    ['gzip', 'deflate'].forEach((encoding) => {
        it(`should inflate response body with ${encoding} encoding`, (done) => {
            request().then(response => {
                assert.equal(response.body, 'foobar');
                assert.equal(response.statusCode, 200);
                assert.equal(response.headers['content-encoding'], 'gzip');
                done();
            }).catch(done);
            const responseStub = new BufferStream(zlib.gzipSync('foobar'));
            responseStub.statusCode = 200;
            responseStub.headers = {
                'content-encoding': 'gzip'
            };
            httpsStub.request.firstCall.args[1](responseStub);
        });
    });

    it('should reject the promise on unzip error', (done) => {
        request().catch(error => {
            assert.equal(error.message, 'incorrect header check');
            done();
        }).catch(done);
        const responseStub = new BufferStream(Buffer.from('not gzipped!'));
        responseStub.headers = {
            'content-encoding': 'gzip'
        };
        httpsStub.request.firstCall.args[1](responseStub);
    });

});
