"use strict";

const nock = require("nock");
const util = require("util");
const assert = require("assert");
const proxyquire = require("proxyquire").noCallThru();
const sinon = require("sinon");
const realRequest = require("../dist/request");

const fail = result =>
  assert.fail(
    `expected promise to be rejected, got resolved with ${util.inspect(result)}`
  );

describe("ServiceClient with stub request", () => {
  /**
   * @type ServiceClientOptions
   */
  let clientOptions;

  const requestStub = sinon.stub();
  const emptySuccessResponse = Promise.resolve({
    statusCode: 200,
    headers: {},
    body: "{}"
  });
  const fakeRequest = Object.assign({}, realRequest, {
    request: requestStub
  });
  const {
    ServiceClient,
    BodyParseError,
    CircuitOpenError,
    RequestFilterError,
    ResponseFilterError,
    RequestNetworkError,
    RequestConnectionTimeoutError,
    RequestUserTimeoutError,
    MaximumRetriesReachedError,
    ShouldRetryRejectedError,
    InternalError
  } = proxyquire("../dist/client", {
    "./request": fakeRequest
  });
  const {
    NetworkError,
    ConnectionTimeoutError,
    UserTimeoutError
  } = fakeRequest;
  const timings = {
    socket: 1,
    lookup: 2,
    connect: 3,
    secureConnect: 4,
    response: 5,
    end: 6
  };
  const timingPhases = {
    wait: 1,
    dns: 1,
    tcp: 1,
    tls: 1,
    firstByte: 1,
    download: 1,
    total: 6
  };

  beforeEach(() => {
    clientOptions = {
      hostname: "catwatch.opensource.zalan.do"
    };
    requestStub.reset();
    requestStub.returns(emptySuccessResponse);
  });

  it("should throw if the service is not provided", () => {
    assert.throws(() => {
      new ServiceClient({}); // eslint-disable-line no-new
    });
  });

  it("should by default send an `accept` application/json header", () => {
    const client = new ServiceClient(clientOptions);
    return client.request().then(() => {
      assert.equal(
        requestStub.firstCall.args[0].headers.accept,
        "application/json"
      );
    });
  });

  it("should not add authorization header if there is no token provider", () => {
    const client = new ServiceClient(clientOptions);
    return client.request().then(() => {
      assert.strictEqual(
        requestStub.firstCall.args[0].headers.authorization,
        undefined
      );
    });
  });

  it("should allow not parsing json body response", () => {
    const client = new ServiceClient(
      Object.assign(
        {
          autoParseJson: false
        },
        clientOptions
      )
    );
    const originalBody = JSON.stringify({ foo: "bar" });
    requestStub.resolves({
      headers: {
        "content-type": "application/x.problem+json"
      },
      body: originalBody
    });
    return client.request().then(({ body }) => {
      assert.strictEqual(body, originalBody);
    });
  });

  it("should automatically parse response as JSON if content type is set correctly", () => {
    const client = new ServiceClient(clientOptions);
    const originalBody = { foo: "bar" };
    requestStub.resolves({
      headers: {
        "content-type": "application/x.problem+json"
      },
      body: JSON.stringify(originalBody)
    });
    return client.request().then(({ body }) => {
      assert.deepStrictEqual(body, originalBody);
    });
  });

  it("should automatically parse response as JSON if content type is not set", () => {
    const client = new ServiceClient(clientOptions);
    const originalBody = { foo: "bar" };
    requestStub.returns(
      Promise.resolve({
        headers: {},
        body: JSON.stringify(originalBody)
      })
    );
    return client.request().then(({ body }) => {
      assert.deepStrictEqual(body, originalBody);
    });
  });

  it("should not throw an error if body or content-type is not set", () => {
    const client = new ServiceClient(clientOptions);
    requestStub.returns(
      Promise.resolve({
        headers: {},
        body: ""
      })
    );
    return client.request().then(({ body }) => {
      assert.equal(body, "");
    });
  });

  it("should throw an error if body is not set for application/json content type", () => {
    const client = new ServiceClient(clientOptions);
    const response = {
      headers: { "content-type": "application/json" },
      body: ""
    };
    requestStub.returns(Promise.resolve(response));
    return client.request().then(fail, err => {
      assert(err instanceof ServiceClient.Error);
      assert.equal(err.type, ServiceClient.BODY_PARSE_FAILED);
      assert(err instanceof BodyParseError);
      assert.deepStrictEqual(err.response, response);
    });
  });

  it("should give a custom error object when the parsing of the body fails", () => {
    const client = new ServiceClient(clientOptions);
    const response = {
      headers: {},
      body: "/not a JSON"
    };
    requestStub.returns(Promise.resolve(response));
    return client.request().then(fail, err => {
      assert(err instanceof ServiceClient.Error);
      assert.equal(err.type, ServiceClient.BODY_PARSE_FAILED);
      assert(err instanceof BodyParseError);
      assert.deepStrictEqual(err.response, response);
    });
  });

  it("should give a custom error object when request fails", () => {
    const client = new ServiceClient(clientOptions);
    const requestError = new NetworkError(new Error("foobar"));
    requestStub.returns(Promise.reject(requestError));
    return client.request().then(fail, err => {
      assert(err instanceof ServiceClient.Error);
      assert.equal(err.type, ServiceClient.REQUEST_FAILED);
      assert(err instanceof RequestNetworkError);
    });
  });

  it("should give a custom error when request timeouts", () => {
    const client = new ServiceClient(clientOptions);
    requestStub.rejects(new ConnectionTimeoutError("foobar"));
    return client.request().then(fail, err => {
      assert(err instanceof ServiceClient.Error);
      assert(err instanceof RequestConnectionTimeoutError);
    });
  });

  it("should give a custom error when request is dropped", () => {
    const client = new ServiceClient(clientOptions);
    requestStub.rejects(new UserTimeoutError("foobar"));
    return client.request().then(fail, err => {
      assert(err instanceof ServiceClient.Error);
      assert(err instanceof RequestUserTimeoutError);
    });
  });

  it("should give a custom error when there is an internal error", () => {
    const client = new ServiceClient(clientOptions);
    requestStub.rejects(new TypeError("foobar"));
    return client.request().then(fail, err => {
      assert(err instanceof ServiceClient.Error);
      assert(err instanceof InternalError);
    });
  });

  it("should copy timings to custom error when request fails", () => {
    const client = new ServiceClient(clientOptions);
    const requestError = new NetworkError(new Error("foobar"), {}, timings);
    requestStub.returns(Promise.reject(requestError));
    return client.request().then(fail, err => {
      assert(err instanceof ServiceClient.Error);
      assert.equal(err.type, ServiceClient.REQUEST_FAILED);
      assert(err instanceof RequestNetworkError);
      assert.deepEqual(err.timings, timings);
      assert.deepEqual(err.timingPhases, timingPhases);
    });
  });

  it("should copy timings to custom error when request fails", () => {
    const client = new ServiceClient(clientOptions);
    const requestOptions = { hostname: "foo" };
    const requestError = new NetworkError(
      new Error("foobar"),
      requestOptions,
      timings
    );
    requestStub.returns(Promise.reject(requestError));
    return client.request().then(fail, err => {
      assert(err instanceof RequestNetworkError);
      assert.deepStrictEqual(err.requestOptions, requestOptions);
    });
  });

  it("should allow to mark request as failed in the request filter", () => {
    clientOptions.filters = [
      {
        request() {
          throw new Error("Failed!");
        }
      }
    ];
    const client = new ServiceClient(clientOptions);
    return client.request().then(fail, err => {
      assert(err instanceof ServiceClient.Error);
      assert.equal(err.type, "Request filter marked request as failed");
      assert(err instanceof RequestFilterError);
    });
  });

  it("should by default handle 5xx code in a response-filter", () => {
    const client = new ServiceClient(clientOptions);
    requestStub.returns(
      Promise.resolve({
        statusCode: 501,
        headers: {},
        body: "{}"
      })
    );
    return client.request().then(fail, err => {
      assert(err instanceof ServiceClient.Error);
      assert.equal(err.type, "Response filter marked request as failed");
      assert(err instanceof ResponseFilterError);
    });
  });

  it("should be able to handle 4xx code as a response-filter", () => {
    clientOptions.filters = [
      ServiceClient.treat4xxAsError,
      ServiceClient.treat5xxAsError
    ];
    const client = new ServiceClient(clientOptions);
    requestStub.returns(
      Promise.resolve({
        statusCode: 403,
        headers: {},
        body: "{}",
        timings,
        timingPhases
      })
    );
    return client.request().then(fail, err => {
      assert(err instanceof ServiceClient.Error);
      assert.equal(err.type, ServiceClient.RESPONSE_FILTER_FAILED);
      assert(err instanceof ResponseFilterError);
      assert.deepEqual(err.timings, timings);
      assert.deepEqual(err.timingPhases, timingPhases);
    });
  });

  it("should be possible to define your own response-filters", () => {
    clientOptions.filters = [
      {
        response(response) {
          if (response.body.error) {
            throw new Error(response.body.error);
          }
          return response;
        }
      }
    ];
    const client = new ServiceClient(clientOptions);
    requestStub.returns(
      Promise.resolve({
        statusCode: 200,
        headers: {},
        body: '{ "error": "non-REST-error" }'
      })
    );
    return client.request().then(fail, err => {
      assert(err instanceof ServiceClient.Error);
      assert.equal(err.type, ServiceClient.RESPONSE_FILTER_FAILED);
      assert(err instanceof ResponseFilterError);
      assert(err.message.includes("non-REST-error"));
    });
  });

  it("should have the original response in a response filter error", () => {
    clientOptions.filters = [
      {
        response() {
          throw new Error();
        }
      }
    ];
    const client = new ServiceClient(clientOptions);
    const response = {
      statusCode: 200,
      headers: {},
      body: '{ "error": "non-REST-error" }'
    };
    requestStub.returns(Promise.resolve(response));
    return client.request().then(fail, err => {
      assert.deepStrictEqual(err.response, response);
    });
  });

  it("should allow to specify request-filters to augment the request", () => {
    clientOptions.filters = [
      {
        request(request) {
          request.path = "foo-bar-buzz";
          return request;
        }
      }
    ];
    const client = new ServiceClient(clientOptions);
    return client.request().then(() => {
      assert.equal(requestStub.firstCall.args[0].path, "foo-bar-buzz");
    });
  });

  it("should allow to specify a request-filters to short-circuit a response", () => {
    const headers = {
      "x-my-custom-header": "foobar"
    };
    const body = {
      foo: "bar"
    };
    clientOptions.filters = [
      {
        request() {
          return new ServiceClient.Response(404, headers, body);
        }
      }
    ];
    const client = new ServiceClient(clientOptions);
    return client.request().then(response => {
      assert.deepStrictEqual(response.headers, headers);
      assert.deepStrictEqual(response.body, body);
    });
  });

  it("should open the circuit after 50% from 11 requests failed", () => {
    const httpErrorResponse = Promise.resolve({
      statusCode: 500,
      headers: {},
      body: "{}"
    });
    const errorResponse = Promise.resolve(
      Promise.reject(new ConnectionTimeoutError("timeout"))
    );

    const responses = [
      emptySuccessResponse,
      emptySuccessResponse,
      httpErrorResponse,
      emptySuccessResponse,
      errorResponse,
      errorResponse,
      httpErrorResponse,
      emptySuccessResponse,
      httpErrorResponse,
      errorResponse,
      emptySuccessResponse
    ];

    responses.forEach((response, index) => {
      requestStub.onCall(index).returns(response);
    });

    clientOptions.circuitBreaker = {};
    const client = new ServiceClient(clientOptions);
    return responses
      .reduce(promise => {
        const tick = () => {
          return client.request();
        };
        return promise.then(tick, tick);
      }, Promise.resolve())
      .then(() => {
        return client.request();
      })
      .then(fail, err => {
        assert(err instanceof ServiceClient.Error);
        assert(err.type, ServiceClient.CIRCUIT_OPEN);
        assert(err instanceof CircuitOpenError);
      });
  });

  describe("built-in filter", () => {
    it("should return original response if all ok", () => {
      return Promise.all(
        [ServiceClient.treat4xxAsError, ServiceClient.treat5xxAsError].map(
          filter => {
            const response = { statusCode: 200 };
            return filter.response(response).then(actual => {
              assert.deepStrictEqual(actual, response);
            });
          }
        )
      );
    });
  });

  describe("request params", () => {
    const expectedDefaultRequestOptions = {
      hostname: "catwatch.opensource.zalan.do",
      protocol: "https:",
      port: 443,
      headers: {
        accept: "application/json"
      },
      pathname: "/",
      timeout: 2000,
      timing: false
    };
    it("should pass reasonable request params by default", () => {
      const client = new ServiceClient(clientOptions);
      return client.request().then(() => {
        assert.deepStrictEqual(
          requestStub.firstCall.args[0],
          expectedDefaultRequestOptions
        );
      });
    });
    it("should allow to pass additional params to the request", () => {
      const client = new ServiceClient(clientOptions);
      return client.requestWithWorker({ foo: "bar" }).then(() => {
        assert.deepStrictEqual(
          requestStub.firstCall.args[0],
          Object.assign({ foo: "bar" }, expectedDefaultRequestOptions)
        );
      });
    });
    it("should allow to override params of the request", () => {
      const client = new ServiceClient(clientOptions);
      return client.requestWithWorker({ pathname: "/foo" }).then(() => {
        assert.deepStrictEqual(
          requestStub.firstCall.args[0],
          Object.assign({}, expectedDefaultRequestOptions, { pathname: "/foo" })
        );
      });
    });
    it("should allow to specify query params of the request", () => {
      const client = new ServiceClient(clientOptions);
      return client
        .requestWithWorker({
          pathname: "/foo",
          query: { param: 1 }
        })
        .then(() => {
          assert.deepStrictEqual(
            requestStub.firstCall.args[0],
            Object.assign({}, expectedDefaultRequestOptions, {
              pathname: "/foo",
              query: { param: 1 }
            })
          );
        });
    });
    it("should allow to specify default params of the request", () => {
      const userDefaultRequestOptions = {
        pathname: "/foo",
        protocol: "http:",
        query: { param: 42 }
      };
      const client = new ServiceClient(
        Object.assign({}, clientOptions, {
          defaultRequestOptions: userDefaultRequestOptions
        })
      );
      return client.request().then(() => {
        assert.deepStrictEqual(
          requestStub.firstCall.args[0],
          Object.assign(
            {},
            expectedDefaultRequestOptions,
            userDefaultRequestOptions,
            { port: 80 }
          )
        );
      });
    });
    it("should not allow to override hostname", () => {
      const client = new ServiceClient(
        Object.assign({}, clientOptions, {
          defaultRequestOptions: { hostname: "zalando.de" }
        })
      );
      return client.request().then(() => {
        assert.deepStrictEqual(
          requestStub.firstCall.args[0],
          Object.assign({}, expectedDefaultRequestOptions)
        );
      });
    });
    it("should support taking hostname and default params from a URL instead of an object", () => {
      const client = new ServiceClient("http://localhost:9999/foo?param=42");
      return client.request().then(() => {
        assert.deepEqual(
          requestStub.firstCall.args[0],
          Object.assign({}, expectedDefaultRequestOptions, {
            port: 9999,
            hostname: "localhost",
            pathname: "/foo",
            protocol: "http:",
            query: {
              param: "42"
            },
            timing: false
          })
        );
      });
    });
  });

  it("should correctly return response if one of the retries succeeds", () => {
    const retrySpy = sinon.spy();
    clientOptions.retryOptions = {
      retries: 3,
      onRetry: retrySpy
    };
    const client = new ServiceClient(clientOptions);
    requestStub.onFirstCall().resolves({
      statusCode: 501,
      headers: {},
      body: "{}"
    });
    requestStub.onSecondCall().resolves({
      statusCode: 200,
      headers: {},
      body: `{"foo":"bar"}`
    });
    return client.request().then(response => {
      assert.equal(retrySpy.callCount, 1);
      assert.deepEqual(response.body, { foo: "bar" });
      assert.equal(response.retryErrors.length, 1);
      assert(response.retryErrors[0] instanceof ResponseFilterError);
    });
  });

  it("should perform the desired number of retries based on the configuration", () => {
    const retrySpy = sinon.spy();
    clientOptions.retryOptions = {
      retries: 3,
      onRetry: retrySpy
    };
    const client = new ServiceClient(clientOptions);
    requestStub.returns(
      Promise.resolve({
        statusCode: 501,
        headers: {},
        body: "{}"
      })
    );
    return client.request().then(fail, err => {
      assert.equal(retrySpy.callCount, 3);
      assert(
        retrySpy.alwaysCalledWithMatch(
          sinon.match.number,
          sinon.match.hasOwn("type"),
          sinon.match.hasOwn("pathname")
        )
      );
      assert.equal(err instanceof ServiceClient.Error, true);
      assert.equal(err.type, "Response filter marked request as failed");
      assert(err instanceof MaximumRetriesReachedError);
      assert.equal(err.retryErrors.length, 4);
      for (const originalError of err.retryErrors) {
        assert(originalError instanceof ResponseFilterError);
      }
    });
  });

  it("should open the circuit after 50% from 11 requests failed and correct number of retries were performed", () => {
    const httpErrorResponse = Promise.resolve({
      statusCode: 500,
      headers: {},
      body: "{}"
    });
    const retrySpy = sinon.spy();
    clientOptions.circuitBreaker = {};
    clientOptions.retryOptions = {
      retries: 1,
      onRetry: retrySpy
    };
    const errorResponse = Promise.resolve(
      Promise.reject(new ConnectionTimeoutError("timeout"))
    );

    const responses = [
      emptySuccessResponse,
      emptySuccessResponse,
      errorResponse,
      emptySuccessResponse,
      httpErrorResponse,
      errorResponse,
      httpErrorResponse,
      emptySuccessResponse,
      errorResponse,
      httpErrorResponse,
      emptySuccessResponse
    ];

    responses.forEach((response, index) => {
      requestStub.onCall(index).returns(response);
    });

    const client = new ServiceClient(clientOptions);
    return responses
      .reduce(promise => {
        const tick = () => {
          return client.request();
        };
        return promise.then(tick, tick);
      }, Promise.resolve())
      .then(() => {
        return client.request();
      })
      .then(fail, err => {
        assert.equal(retrySpy.callCount, 4);
        assert(
          retrySpy.alwaysCalledWithMatch(
            sinon.match.number,
            sinon.match.hasOwn("type"),
            sinon.match.hasOwn("pathname")
          )
        );
        assert.equal(err instanceof ServiceClient.Error, true);
        assert.equal(err.type, ServiceClient.CIRCUIT_OPEN);
        assert(err instanceof CircuitOpenError);
      });
  });

  it("should not retry if the shouldRetry function returns false", () => {
    const retrySpy = sinon.spy();
    clientOptions.retryOptions = {
      retries: 1,
      shouldRetry(err) {
        return err.response.statusCode !== 501;
      },
      onRetry: retrySpy
    };
    const client = new ServiceClient(clientOptions);
    requestStub.returns(
      Promise.resolve({
        statusCode: 501,
        headers: {},
        body: "{}"
      })
    );
    return client.request().then(fail, err => {
      assert.equal(retrySpy.callCount, 0);
      assert.equal(err instanceof ServiceClient.Error, true);
      assert.equal(err.type, "Response filter marked request as failed");
      assert(err instanceof ShouldRetryRejectedError);
    });
  });

  it("should prepend the ServiceClient name to errors", () => {
    clientOptions.name = "TestClient";
    const client = new ServiceClient(clientOptions);
    const requestError = new NetworkError(new Error("foobar"));
    requestStub.returns(Promise.reject(requestError));
    return client.request().then(fail, err => {
      assert.equal(err.message, "TestClient: HTTP Request failed. foobar");
    });
  });

  it("should default to hostname in errors if no name is specified", () => {
    const client = new ServiceClient(clientOptions);
    const requestError = new NetworkError(new Error("foobar"));
    requestStub.returns(Promise.reject(requestError));
    return client.request().then(fail, err => {
      assert.equal(
        err.message,
        "catwatch.opensource.zalan.do: HTTP Request failed. foobar"
      );
    });
  });

  it("accepts and uses circuit breaker factory", () => {
    const noop = () => null;
    const breaker = {
      run: sinon.spy(command => command(noop, noop))
    };

    const client = new ServiceClient(
      Object.assign({}, clientOptions, {
        circuitBreaker: () => breaker
      })
    );

    assert(client.getCircuitBreaker({}) === breaker);
  });

  it("uses circuit breaker factory while making requests", () => {
    const noop = () => null;
    const breaker = {
      run: sinon.spy(command => command(noop, noop))
    };
    const breakerFactory = sinon.spy(() => breaker);

    const client = new ServiceClient(
      Object.assign({}, clientOptions, {
        circuitBreaker: breakerFactory
      })
    );

    return client.request().then(() => {
      assert(breaker.run.calledOnce);
      assert(breakerFactory.calledWithMatch(clientOptions));
    });
  });
});

describe("ServiceClient with nock response", () => {
  const { ServiceClient } = require("../dist/client");
  /**
   * @type ServiceClientOptions
   */
  let clientOptions;
  beforeEach(() => {
    clientOptions = {
      hostname: "catwatch.opensource.zalan.do"
    };
  });
  describe("metrics", async () => {
    it("should return the timing metrics when timing enabled in client", async () => {
      nock("https://catwatch.opensource.zalan.do")
        .get("/")
        .reply(200);
      const optsWithTimingEnabled = Object.assign({}, clientOptions, {
        timing: true
      });
      const client = new ServiceClient(optsWithTimingEnabled);

      const response = await client.request();

      assert(response.timings != null);
      assert(response.timingPhases != null);
    });

    it("should not return the timing metrics when timing disabled in client", async () => {
      nock("https://catwatch.opensource.zalan.do")
        .get("/")
        .reply(200);
      const optsWithTimingEnabled = Object.assign({}, clientOptions, {
        timing: false
      });
      const client = new ServiceClient(optsWithTimingEnabled);

      const response = await client.request();

      assert(response.timings == null);
      assert(response.timingPhases == null);
    });
  });
});
