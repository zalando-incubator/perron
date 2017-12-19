'use strict'

const assert = require('assert')
const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')
const realRequest = require('../dist/request')

describe('ServiceClient', () => {
  let clientOptions

  const requestStub = sinon.stub()
  const emptySuccessResponse = Promise.resolve({
    statusCode: 200,
    headers: {},
    body: '{}'
  })
  const {ServiceClient} = proxyquire('../dist/client', {
    './request': {
      request: requestStub,
      ServiceClientResponse: realRequest.ServiceClientResponse,
      ServiceClientRequestOptions: realRequest.ServiceClientRequestOptions
    }
  })

  beforeEach(() => {
    clientOptions = {
      hostname: 'catwatch.opensource.zalan.do'
    }
    requestStub.reset()
    requestStub.returns(emptySuccessResponse)
  })

  it('should throw if the service is not provided', () => {
    assert.throws(() => {
      new ServiceClient({}) // eslint-disable-line no-new
    })
  })

  it('should by default send an `accept` application/json header', () => {
    const client = new ServiceClient(clientOptions)
    return client.request().then(() => {
      assert.equal(
        requestStub.firstCall.args[0].headers.accept,
        'application/json'
      )
    })
  })

  it('should not add authorization header if there is no token provider', () => {
    const client = new ServiceClient(clientOptions)
    return client.request().then(() => {
      assert.strictEqual(
        requestStub.firstCall.args[0].headers.authorization,
        undefined
      )
    })
  })

  it('should automatically parse response as JSON if content type is set correctly', () => {
    const client = new ServiceClient(clientOptions)
    const originalBody = {foo: 'bar'}
    requestStub.returns({
      headers: {
        'content-type': 'application/x.problem+json'
      },
      body: JSON.stringify(originalBody)
    })
    return client.request().then(({body}) => {
      assert.deepStrictEqual(body, originalBody)
    })
  })

  it('should automatically parse response as JSON if content type is not set', () => {
    const client = new ServiceClient(clientOptions)
    const originalBody = {foo: 'bar'}
    requestStub.returns(Promise.resolve({
      headers: {},
      body: JSON.stringify(originalBody)
    }))
    return client.request().then(({body}) => {
      assert.deepStrictEqual(body, originalBody)
    })
  })

  it('should not throw an error if body or content-type is not set', () => {
    const client = new ServiceClient(clientOptions)
    requestStub.returns(Promise.resolve({
      headers: {},
      body: ''
    }))
    return client.request().then(({body}) => {
      assert.equal(body, '')
    })
  })

  it('should throw an error if body is not set for application/json content type', (done) => {
    const client = new ServiceClient(clientOptions)
    const response = {
      headers: {'content-type': 'application/json'},
      body: ''
    }
    requestStub.returns(Promise.resolve(response))
    client.request().catch((err) => {
      assert(err instanceof ServiceClient.Error)
      assert.equal(err.type, ServiceClient.BODY_PARSE_FAILED)
      assert.deepStrictEqual(err.response, response)
      done()
    })
  })

  it('should give a custom error object when the parsing of the body fails', (done) => {
    const client = new ServiceClient(clientOptions)
    const response = {
      headers: {},
      body: '/not a JSON'
    }
    requestStub.returns(Promise.resolve(response))
    client.request().catch(err => {
      assert(err instanceof ServiceClient.Error)
      assert.equal(err.type, ServiceClient.BODY_PARSE_FAILED)
      assert.deepStrictEqual(err.response, response)
      done()
    })
  })

  it('should give a custom error object when request fails', () => {
    const client = new ServiceClient(clientOptions)
    const requestError = new Error('foobar')
    requestStub.returns(Promise.reject(requestError))
    return client.request().catch(err => {
      assert(err instanceof ServiceClient.Error)
      assert.equal(err.type, ServiceClient.REQUEST_FAILED)
    })
  })

  it('should allow to mark request as failed in the request filter', (done) => {
    clientOptions.filters = [{
      request () {
        throw new Error('Failed!')
      }
    }]
    const client = new ServiceClient(clientOptions)
    client.request().catch(err => {
      assert(err instanceof ServiceClient.Error)
      assert.equal(err.type, 'Request filter marked request as failed')
      done()
    })
  })

  it('should by default handle 5xx code in a response-filter', (done) => {
    const client = new ServiceClient(clientOptions)
    requestStub.returns(Promise.resolve({
      statusCode: 501,
      headers: {},
      body: '{}'
    }))
    client.request().catch(err => {
      assert(err instanceof ServiceClient.Error)
      assert.equal(err.type, 'Response filter marked request as failed')
      done()
    })
  })

  it('should be able to handle 4xx code as a response-filter', (done) => {
    clientOptions.filters = [
      ServiceClient.treat4xxAsError,
      ServiceClient.treat5xxAsError
    ]
    const client = new ServiceClient(clientOptions)
    requestStub.returns(Promise.resolve({
      statusCode: 403,
      headers: {},
      body: '{}'
    }))
    client.request().catch(err => {
      assert(err instanceof ServiceClient.Error)
      assert.equal(err.type, ServiceClient.RESPONSE_FILTER_FAILED)
      done()
    })
  })

  it('should be possible to define your own response-filters', (done) => {
    clientOptions.filters = [{
      response (response) {
        if (response.body.error) {
          throw new Error(response.body.error)
        }
        return response
      }
    }]
    const client = new ServiceClient(clientOptions)
    requestStub.returns(Promise.resolve({
      statusCode: 200,
      headers: {},
      body: '{ "error": "non-REST-error" }'
    }))
    client.request().catch(err => {
      assert(err instanceof ServiceClient.Error)
      assert.equal(err.type, ServiceClient.RESPONSE_FILTER_FAILED)
      assert(err.message.includes('non-REST-error'))
      done()
    })
  })

  it('should have the original response in a response filter error', (done) => {
    clientOptions.filters = [{
      response () {
        throw new Error()
      }
    }]
    const client = new ServiceClient(clientOptions)
    const response = {
      statusCode: 200,
      headers: {},
      body: '{ "error": "non-REST-error" }'
    }
    requestStub.returns(Promise.resolve(response))
    client.request().catch(err => {
      assert.deepStrictEqual(err.response, response)
      done()
    })
  })

  it('should allow to specify request-filters to augment the request', (done) => {
    clientOptions.filters = [{
      request (request) {
        request.path = 'foo-bar-buzz'
        return request
      }
    }]
    const client = new ServiceClient(clientOptions)
    client.request().then(() => {
      assert.equal(
        requestStub.firstCall.args[0].path,
        'foo-bar-buzz'
      )
      done()
    })
  })

  it('should allow to specify a request-filters to short-circuit a response', (done) => {
    const headers = {
      'x-my-custom-header': 'foobar'
    }
    const body = {
      foo: 'bar'
    }
    clientOptions.filters = [{
      request () {
        return new ServiceClient.Response(404, headers, body)
      }
    }]
    const client = new ServiceClient(clientOptions)
    client.request().then((response) => {
      assert.deepStrictEqual(response.headers, headers)
      assert.deepStrictEqual(response.body, body)
      done()
    })
  })

  it('should open the circuit after 50% from 11 requests failed', () => {
    const httpErrorResponse = Promise.resolve({
      statusCode: 500,
      headers: {},
      body: '{}'
    })
    const errorResponse = Promise.resolve(Promise.reject(new Error('timeout')))
    const requests = Array.from({length: 11});

    [emptySuccessResponse, emptySuccessResponse, httpErrorResponse, emptySuccessResponse, errorResponse, errorResponse,
      httpErrorResponse, emptySuccessResponse, httpErrorResponse, errorResponse, emptySuccessResponse
    ].forEach((response, index) => {
      requestStub.onCall(index).returns(response)
    })

    const client = new ServiceClient(clientOptions)
    return requests.reduce((promise) => {
      const tick = () => {
        return client.request()
      }
      return promise.then(tick, tick)
    }, Promise.resolve()).then(() => {
      return client.request().catch((err) => {
        assert(err instanceof ServiceClient.Error)
        assert(err.type, ServiceClient.CIRCUIT_OPEN)
      })
    })
  })

  describe('built-in filter', () => {
    it('should return original response if all ok', () => {
      return Promise.all([ServiceClient.treat4xxAsError, ServiceClient.treat5xxAsError].map(filter => {
        const response = {statusCode: 200}
        return filter.response(response).then((actual) => {
          assert.deepStrictEqual(actual, response)
        })
      }))
    })
  })

  describe('request params', () => {
    const expectedDefaultRequestOptions = {
      hostname: 'catwatch.opensource.zalan.do',
      protocol: 'https:',
      port: 443,
      headers: {
        accept: 'application/json'
      },
      pathname: '/',
      timeout: 2000
    }
    it('should pass reasonable request params by default', () => {
      const client = new ServiceClient(clientOptions)
      return client.request().then(() => {
        assert.deepStrictEqual(requestStub.firstCall.args[0], expectedDefaultRequestOptions)
      })
    })
    it('should allow to pass additional params to the request', () => {
      const client = new ServiceClient(clientOptions)
      return client.request({foo: 'bar'}).then(() => {
        assert.deepStrictEqual(
          requestStub.firstCall.args[0],
          Object.assign({foo: 'bar'}, expectedDefaultRequestOptions)
        )
      })
    })
    it('should allow to override params of the request', () => {
      const client = new ServiceClient(clientOptions)
      return client.request({pathname: '/foo'}).then(() => {
        assert.deepStrictEqual(
          requestStub.firstCall.args[0],
          Object.assign({}, expectedDefaultRequestOptions, {pathname: '/foo'})
        )
      })
    })
    it('should allow to specify query params of the request', () => {
      const client = new ServiceClient(clientOptions)
      return client.request({
        pathname: '/foo',
        query: {param: 1}
      }).then(() => {
        assert.deepStrictEqual(
          requestStub.firstCall.args[0],
          Object.assign({}, expectedDefaultRequestOptions, {
            pathname: '/foo',
            query: {param: 1}
          })
        )
      })
    })
    it('should allow to specify default params of the request', () => {
      const userDefaultRequestOptions = {
        pathname: '/foo',
        protocol: 'http:',
        query: {param: 42}
      }
      const client = new ServiceClient(Object.assign({}, clientOptions, {
        defaultRequestOptions: userDefaultRequestOptions
      }))
      return client.request().then(() => {
        assert.deepStrictEqual(
          requestStub.firstCall.args[0],
          Object.assign({}, expectedDefaultRequestOptions, userDefaultRequestOptions, {port: 80})
        )
      })
    })
    it('should not allow to override hostname', () => {
      const client = new ServiceClient(Object.assign({}, clientOptions, {
        defaultRequestOptions: {hostname: 'zalando.de'}
      }))
      return client.request().then(() => {
        assert.deepStrictEqual(
          requestStub.firstCall.args[0],
          Object.assign({}, expectedDefaultRequestOptions)
        )
      })
    })
    it('should support taking hostname and default params from a URL instead of an object', () => {
      const client = new ServiceClient('http://localhost:9999/foo?param=42')
      return client.request().then(() => {
        assert.deepEqual(
          requestStub.firstCall.args[0],
          Object.assign({}, expectedDefaultRequestOptions, {
            port: 9999,
            hostname: 'localhost',
            pathname: '/foo',
            protocol: 'http:',
            query: {
              param: '42'
            }
          })
        )
      })
    })
  })

  it('should perform the desired number of retries based on the configuration', () => {
    const retrySpy = sinon.spy()
    clientOptions.retryOptions = {
      retries: 3,
      onRetry: retrySpy
    }
    const client = new ServiceClient(clientOptions)
    requestStub.returns(Promise.resolve({
      statusCode: 501,
      headers: {},
      body: '{}'
    }))
    return client.request().catch(err => {
      assert.equal(retrySpy.callCount, 3)
      assert(retrySpy.alwaysCalledWithMatch(sinon.match.number, sinon.match.hasOwn('type'), sinon.match.hasOwn('pathname')))
      assert.equal(err instanceof ServiceClient.Error, true)
      assert.equal(err.type, 'Response filter marked request as failed')
    })
  })

  it('should open the circuit after 50% from 11 requests failed and correct number of retries were performed', () => {
    const httpErrorResponse = Promise.resolve({
      statusCode: 500,
      headers: {},
      body: '{}'
    })
    const retrySpy = sinon.spy()
    clientOptions.retryOptions = {
      retries: 1,
      onRetry: retrySpy
    }
    const errorResponse = Promise.resolve(Promise.reject(new Error('timeout')))
    const requests = Array.from({length: 11});

    [emptySuccessResponse, emptySuccessResponse, errorResponse, emptySuccessResponse, httpErrorResponse, errorResponse,
      httpErrorResponse, emptySuccessResponse, errorResponse, httpErrorResponse, emptySuccessResponse
    ].forEach((response, index) => {
      requestStub.onCall(index).returns(response)
    })

    const client = new ServiceClient(clientOptions)
    return requests.reduce((promise) => {
      const tick = () => {
        return client.request()
      }
      return promise.then(tick, tick)
    }, Promise.resolve()).then(() => {
      return client.request()
    }).catch((err) => {
      assert.equal(retrySpy.callCount, 4)
      assert(retrySpy.alwaysCalledWithMatch(sinon.match.number, sinon.match.hasOwn('type'), sinon.match.hasOwn('pathname')))
      assert.equal(err instanceof ServiceClient.Error, true)
      assert.equal(err.type, ServiceClient.CIRCUIT_OPEN)
    })
  })

  it('should not retry if the shouldRetry function returns false', () => {
    const retrySpy = sinon.spy()
    clientOptions.retryOptions = {
      retries: 1,
      shouldRetry (err) {
        if (err.response.statusCode === 501) {
          return false
        }
        return true
      },
      onRetry: retrySpy
    }
    const client = new ServiceClient(clientOptions)
    requestStub.returns(Promise.resolve({
      statusCode: 501,
      headers: {},
      body: '{}'
    }))
    return client.request().catch(err => {
      assert.equal(retrySpy.callCount, 0)
      assert.equal(err instanceof ServiceClient.Error, true)
      assert.equal(err.type, 'Response filter marked request as failed')
    })
  })

  it('should prepend the ServiceClient name to errors', () => {
    clientOptions.name = 'TestClient'
    const client = new ServiceClient(clientOptions)
    const requestError = new Error('foobar')
    requestStub.returns(Promise.reject(requestError))
    return client.request().catch(err => {
      assert.equal(err.message, 'TestClient: HTTP Request failed. foobar')
    })
  })

  it('should default to hostname in errors if no name is specified', () => {
    const client = new ServiceClient(clientOptions)
    const requestError = new Error('foobar')
    requestStub.returns(Promise.reject(requestError))
    return client.request().catch(err => {
      assert.equal(err.message, 'catwatch.opensource.zalan.do: HTTP Request failed. foobar')
    })
  })
})
