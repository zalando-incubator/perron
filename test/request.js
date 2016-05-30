
const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const EventEmitter = require('events');

class ResponseStub extends EventEmitter {}
class RequestStub extends EventEmitter {
    end() {}
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
        request();
        assert.equal(httpsStub.request.callCount, 1);
    });

    it('should allow to call http if it is specified as protocol', () => {
        request({ protocol: 'http:' });
        assert.equal(httpStub.request.callCount, 1);
    });

    it('should return a promise', () => {
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
        responseStub.emit('data', 'foo');
        responseStub.emit('data', 'bar');
        responseStub.emit('end');
    });


});
