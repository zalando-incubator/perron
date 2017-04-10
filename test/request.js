
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
        this.i = 0;
        this.buffer = buffer;
    }
    _read() {
        const chunk = this.i < this.buffer.length ? this.buffer.slice(this.i, ++this.i) : null;
        this.push(chunk);
    }
}

describe('request', () => {

    const httpStub = {};
    const httpsStub = {};

    let request = proxyquire('../lib/request', {
        http: httpStub,
        https: httpsStub
    });

    beforeEach(() => {
        httpStub.request = sinon.stub();
        httpsStub.request = sinon.stub();
    });

    it('should call https if protocol is not specified', () => {
        const requestStub = new RequestStub();
        httpsStub.request.returns(requestStub);
        request();
        assert.equal(httpsStub.request.callCount, 1);
    });

    it('should allow to call http if it is specified as protocol', () => {
        const requestStub = new RequestStub();
        httpStub.request.returns(requestStub);
        request({ protocol: 'http:' });
        assert.equal(httpStub.request.callCount, 1);
    });

    it('should return a promise', () => {
        const requestStub = new RequestStub();
        httpsStub.request.returns(requestStub);
        assert(typeof request().then, 'function');
    });

    it('should reject a promise if request errors out', (done) => {
        const requestStub = new RequestStub();
        httpsStub.request.returns(requestStub);
        request().catch(() => {
            done();
        });
        requestStub.emit('error');
    });

    it('should use the body of the request if one is provided', () => {
        const requestStub = new RequestStub();
        httpsStub.request.returns(requestStub);
        requestStub.write = sinon.spy();
        request({
            body: 'foobar'
        });
        assert.equal(requestStub.write.firstCall.args[0], 'foobar');
    });

    it('should resolve the promise with full response on success', (done) => {
        const requestStub = new RequestStub();
        httpsStub.request.returns(requestStub);
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
        const requestStub = new RequestStub();
        httpsStub.request.returns(requestStub);
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
        const requestStub = new RequestStub();
        httpsStub.request.returns(requestStub);
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
            const requestStub = new RequestStub();
            httpsStub.request.returns(requestStub);
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
        const requestStub = new RequestStub();
        httpsStub.request.returns(requestStub);
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
