
const assert = require('assert');
const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');

describe('ServiceClient', () => {
    let clientOptions;

    const requestStub = sinon.stub();

    const ServiceClient = proxyquire('../lib/client', {
        './request': requestStub
    });

    beforeEach(() => {
        clientOptions = {
            hostname: 'catwatch.opensource.zalan.do'
        };
        requestStub.reset().returns(Promise.resolve({ headers: {}, body: '{}' }));
    });

    it('should throw if the service is not provided', () => {
        assert.throws(() => { new ServiceClient({}); });
    });

    it('should by default send an `accept` application/json header', () => {
        const client = new ServiceClient(clientOptions);
        return client.request().then(() => {
            assert.equal(
                requestStub.firstCall.args[0].headers.accept,
                'application/json'
            );
        });
    });

    it('should not add authorization header if there is no token provider', () => {
        const client = new ServiceClient(clientOptions);
        return client.request().then(() => {
            assert.strictEqual(
                requestStub.firstCall.args[0].headers.authorization,
                undefined
            );
        });
    });

    it('should automatically parse response as JSON if content type is set correctly', () => {
        const client = new ServiceClient(clientOptions);
        const originalBody = { foo: 'bar' };
        requestStub.returns({
            headers: {
                'content-type': 'application/json+something'
            },
            body: JSON.stringify(originalBody)
        });
        return client.request().then(({ body }) => {
            assert.deepStrictEqual(body, originalBody);
        });
    });

    it('should not throw error for empty response body', () => {
        const client = new ServiceClient(clientOptions);
        const originalBody = null;
        requestStub.returns({
            headers: {
                'accept': 'text/plain'
            },
            body: null
        });
        return assert.doesNotThrow(() => {
            client.request().then(({ body }) => {
                assert.equal(body, originalBody);
            });    
        });
    });

    it('should automatically parse response as JSON if content type is not set', () => {
        const client = new ServiceClient(clientOptions);
        const originalBody = { foo: 'bar' };
        requestStub.returns(Promise.resolve({
            headers: {},
            body: JSON.stringify(originalBody)
        }));
        return client.request().then(({ body }) => {
            assert.deepStrictEqual(body, originalBody);
        });
    });

    it('should give a custom error object when the parsing of the body fails', () => {
        const client = new ServiceClient(clientOptions);
        const response = {
            headers: {},
            body: '/not a JSON'
        };
        requestStub.returns(Promise.resolve(response));
        return client.request().catch(err => {
            assert(err instanceof ServiceClient.Error);
            assert.equal(err.type, ServiceClient.BODY_PARSE_FAILED);
            assert.deepStrictEqual(err.response, response);
        });
    });

    it('should give a custom error object when request fails', () => {
        const client = new ServiceClient(clientOptions);
        const requestError = new Error('foobar');
        requestStub.returns(Promise.reject(requestError));
        return client.request().catch(err => {
            assert(err instanceof ServiceClient.Error);
            assert.equal(err.type, ServiceClient.REQUEST_FAILED);
        });
    });

    it('should by default handle 5xx code in a response-filter', () => {
        const client = new ServiceClient(clientOptions);
        requestStub.returns(Promise.resolve({
            statusCode: 501,
            headers: {},
            body: '{}'
        }));
        return client.request().catch(err => {
            assert(err instanceof ServiceClient.Error);
            assert.equal(err.type, ServiceClient.RESPONSE_FILTER_FAILED);
        });
    });

    it('should be able to handle 4xx code as a response-filter', (done) => {
        clientOptions.filters = [
            ServiceClient.treat4xxAsError,
            ServiceClient.treat5xxAsError
        ];
        const client = new ServiceClient(clientOptions);
        requestStub.returns(Promise.resolve({
            statusCode: 403,
            headers: {},
            body: '{}'
        }));
        client.request().catch(err => {
            assert(err instanceof ServiceClient.Error);
            assert.equal(err.type, ServiceClient.RESPONSE_FILTER_FAILED);
            done();
        });
    });

    it('should be possible to define your own response-filters', (done) => {
        clientOptions.filters = [{
            response(response) {
                if (response.body.error) {
                    throw new Error(response.body.error);
                }
                return response;
            }
        }];
        const client = new ServiceClient(clientOptions);
        requestStub.returns(Promise.resolve({
            statusCode: 200,
            headers: {},
            body: '{ "error": "non-REST-error" }'
        }));
        client.request().catch(err => {
            assert(err instanceof ServiceClient.Error);
            assert.equal(err.type, ServiceClient.RESPONSE_FILTER_FAILED);
            assert(err.message.includes('non-REST-error'));
            done();
        });
    });

    it('should have the original response in a response filter error', (done) => {
        clientOptions.filters = [{
            response() {
                throw new Error();
            }
        }];
        const client = new ServiceClient(clientOptions);
        const response = {
            statusCode: 200,
            headers: {},
            body: '{ "error": "non-REST-error" }'
        };
        requestStub.returns(Promise.resolve(response));
        client.request().catch(err => {
            assert.deepStrictEqual(err.response, response);
            done();
        });
    });

    it('should allow to specify request-filters to augment the request', (done) => {
        clientOptions.filters = [{
            request(request) {
                request.path = 'foo-bar-buzz';
                return request;
            }
        }];
        const client = new ServiceClient(clientOptions);
        requestStub.returns(Promise.resolve({
            statusCode: 200,
            headers: {},
            body: '{}'
        }));
        return client.request().then(() => {
            assert.equal(
                requestStub.firstCall.args[0].path,
                'foo-bar-buzz'
            );
            done();
        });
    });

    it('should allow to specify a request-filters to short-circuit a response', (done) => {
        const headers = {
            'x-my-custom-header': 'foobar'
        };
        const body = {
            foo: 'bar'
        };
        clientOptions.filters = [{
            request() {
                return new ServiceClient.Response(404, headers, body);
            }
        }];
        const client = new ServiceClient(clientOptions);
        return client.request().then((response) => {
            assert.deepStrictEqual(response.headers, headers);
            assert.deepStrictEqual(response.body, body);
            done();
        });
    });

    it('should open the circuit after 50% from 11 requests failed', () => {
        const successResponse = Promise.resolve({
            statusCode: 200,
            headers: {},
            body: '{}'
        });
        const httpErrorResponse = Promise.resolve({
            statusCode: 500,
            headers: {},
            body: '{}'
        });
        const errorResponse = Promise.resolve(Promise.reject(new Error('timeout')));
        const requests = Array.from({length: 11});

        [
            successResponse, successResponse, httpErrorResponse, successResponse, errorResponse, errorResponse,
            httpErrorResponse, successResponse, httpErrorResponse, errorResponse, successResponse
        ].forEach((response, i) => {
            requestStub.onCall(i).returns(response);
        });

        const client = new ServiceClient(clientOptions);
        return requests.reduce((promise) => {
            const tick = () => {
                return client.request();
            };
            return promise.then(tick, tick);
        }, Promise.resolve()).then(() => {
            return client.request().catch((err) => {
                assert(err instanceof ServiceClient.Error);
                assert(err.type, ServiceClient.CIRCUIT_OPEN);
            });
        });
    });

    describe('built-in filter', () => {
        it('should return original response if all ok', () => {
            [ServiceClient.treat4xxAsError, ServiceClient.treat5xxAsError].forEach(filter => {
                const response = { statusCode: 200 };
                assert.deepStrictEqual(filter.response(response), response);
            });
        });
    });
});
