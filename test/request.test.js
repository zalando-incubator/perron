"use strict";

const assert = require("assert");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();
const EventEmitter = require("events");
const zlib = require("zlib");
const stream = require("stream");

class ResponseStub extends EventEmitter {}

class RequestStub extends EventEmitter {
  constructor() {
    super();
    this.setTimeout = sinon.stub();
  }
  end() {}
}

class SocketStub extends EventEmitter {
  constructor(connecting) {
    super();
    this.connecting = connecting;
    this.setTimeout = sinon.stub();
    this.destroy = sinon.stub();
  }
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
const fail = result =>
  assert.fail(`expected promise to be rejected, got resolved with ${result}`);

describe("request", () => {
  const httpStub = {};
  const httpsStub = {};

  let request = proxyquire("../dist/request", {
    http: httpStub,
    https: httpsStub
  }).request;
  let requestStub;
  let clock;

  beforeEach(() => {
    httpStub.request = sinon.stub();
    httpsStub.request = sinon.stub();
    requestStub = new RequestStub();
    httpsStub.request.returns(requestStub);
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it("should call https if protocol is not specified", () => {
    request();
    assert.equal(httpsStub.request.callCount, 1);
  });

  it("should allow to call http if it is specified as protocol", () => {
    httpsStub.request.returns(undefined);
    httpStub.request.returns(requestStub);
    request({ protocol: "http:" });
    assert.equal(httpStub.request.callCount, 1);
  });

  it("should use pathname as path if none specified", () => {
    request({ pathname: "/foo" });
    assert.equal(httpsStub.request.firstCall.args[0].path, "/foo");
  });

  it("should prefer fully resolved path even if pathname is specified", () => {
    request({
      pathname: "/foo",
      path: "/bar"
    });
    assert.equal(httpsStub.request.firstCall.args[0].path, "/bar");
  });

  it("should allow to specify query params as an object", () => {
    request({
      query: {
        foo: "bar",
        buz: 42
      },
      pathname: "/"
    });
    assert.equal(httpsStub.request.firstCall.args[0].path, "/?foo=bar&buz=42");
  });

  it("should not add a question mark with empty query", () => {
    request({
      query: {},
      pathname: "/foo"
    });
    assert.equal(httpsStub.request.firstCall.args[0].path, "/foo");
  });

  it("should return a promise", () => {
    assert(typeof request().then, "function");
  });

  it("should reject a promise if request errors out", () => {
    const requestPromise = request();
    requestStub.emit("error", new Error("foo"));
    return requestPromise.then(fail, err => assert.equal(err.message, "foo"));
  });

  it("should use the body of the request if one is provided", () => {
    requestStub.write = sinon.spy();
    request({
      body: "foobar"
    });
    assert.equal(requestStub.write.firstCall.args[0], "foobar");
  });

  it("should return body of type Buffer when autoDecodeUtf8 is set to false ", () => {
    const promise = request({
      autoDecodeUtf8: false
    });
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    responseStub.emit("data", Buffer.from("foo"));
    responseStub.emit("data", Buffer.from("bar"));
    responseStub.emit("end");
    return promise.then(response => {
      assert.deepEqual(response.body, Buffer.from("foobar"));
    });
  });

  it("should resolve the promise with full response on success", () => {
    const promise = request();
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    responseStub.emit("data", Buffer.from("foo"));
    responseStub.emit("data", Buffer.from("bar"));
    responseStub.emit("end");
    return promise.then(response => {
      assert.equal(response.body, "foobar");
    });
  });

  it("should reject the promise on response error", () => {
    const promise = request();
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    responseStub.emit("data", Buffer.from("foo"));
    responseStub.emit("error", new Error("test"));
    return promise.then(fail, error => {
      assert.equal(error.message, "test");
    });
  });

  it("should support responses chunked between utf8 boundaries", () => {
    const promise = request();
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    const data = Buffer.from("я");
    responseStub.emit("data", Buffer.from([data[0]]));
    responseStub.emit("data", Buffer.from([data[1]]));
    responseStub.emit("end");
    return promise.then(response => {
      assert.equal(response.body, "я");
    });
  });

  ["gzip", "deflate"].forEach(encoding => {
    it(`should inflate response body with ${encoding} encoding`, () => {
      const promise = request();
      const responseStub = new BufferStream(zlib.gzipSync("foobar"));
      responseStub.statusCode = 200;
      responseStub.headers = {
        "content-encoding": "gzip"
      };
      requestStub.emit("response", responseStub);
      return promise.then(response => {
        assert.equal(response.body, "foobar");
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["content-encoding"], "gzip");
      });
    });
  });

  it("should reject the promise on unzip error", () => {
    const promise = request();
    const responseStub = new BufferStream(Buffer.from("not gzipped!"));
    responseStub.headers = {
      "content-encoding": "gzip"
    };
    requestStub.emit("response", responseStub);
    return promise.then(fail, error => {
      assert.equal(error.message, "incorrect header check");
    });
  });

  it("should reject the promise on connection timeout", done => {
    const timeout = 100;
    const host = "example.org";

    request({ timeout, host })
      .then(fail, error => {
        assert.strictEqual(error.message, "socket timeout");
        sinon.assert.calledWith(socketStub.setTimeout.firstCall, timeout);
        sinon.assert.calledOnce(socketStub.setTimeout);
        sinon.assert.calledOnce(socketStub.destroy);
        done();
      })
      .catch(done);

    const socketStub = new SocketStub(true);
    requestStub.emit("socket", socketStub);
    socketStub.setTimeout.invokeCallback();
  });

  it("should reject the promise on read timeout", done => {
    const readTimeout = 100;
    const host = "example.org";

    request({ readTimeout, host })
      .then(fail, error => {
        assert.strictEqual(error.message, "read timeout");
        sinon.assert.calledWith(requestStub.setTimeout.firstCall, readTimeout);
        sinon.assert.calledOnce(requestStub.setTimeout);
        sinon.assert.calledOnce(requestStub.socket.destroy);
        done();
      })
      .catch(done);

    const socketStub = new SocketStub(false);
    requestStub.socket = socketStub;
    requestStub.emit("socket", socketStub);
    requestStub.setTimeout.invokeCallback();
  });

  it("should resolve the promise when response finishes in time", () => {
    requestStub.abort = sinon.stub();
    const responseStub = new ResponseStub();
    const promise = request({ dropRequestAfter: 500 });
    clock.tick(100);
    requestStub.emit("response", responseStub);
    clock.tick(100);
    responseStub.emit("data", Buffer.from("hello"));
    clock.tick(100);
    responseStub.emit("end");
    return promise.then(response => {
      assert.equal(response.body, "hello");
      assert(!requestStub.abort.called);
    });
  });

  it("should resolve the promise when response finishes in time without data", () => {
    requestStub.abort = sinon.stub();
    const responseStub = new ResponseStub();
    const promise = request({ dropRequestAfter: 500 });
    clock.tick(100);
    requestStub.emit("response", responseStub);
    clock.tick(100);
    responseStub.emit("end");
    return promise.then(response => {
      assert.equal(response.body, "");
      assert(!requestStub.abort.called);
    });
  });

  it("should attach the request options to the response", () => {
    requestStub.abort = sinon.stub();
    const responseStub = new ResponseStub();
    const requestOptions = {
      test: "item"
    };
    const promise = request(requestOptions);
    clock.tick(100);
    requestStub.emit("response", responseStub);
    clock.tick(100);
    responseStub.emit("end");
    return promise.then(response => {
      assert.equal(response.request.test, requestOptions.test);
      assert(!requestStub.abort.called);
    });
  });

  it("should reject the promise when response arrives but does not finish in time", () => {
    requestStub.abort = sinon.stub();
    const responseStub = new ResponseStub();
    responseStub.destroy = sinon.stub();
    const promise = request({ dropRequestAfter: 500 });
    clock.tick(100);
    requestStub.emit("response", responseStub);
    clock.tick(100);
    responseStub.emit("data", "hello");
    clock.tick(300);
    return promise.then(fail, error => {
      assert.equal(error.message, "request timeout");
      assert(requestStub.abort.called);
    });
  });

  it("should reject the promise when response does not arrive in time", () => {
    requestStub.abort = sinon.stub();
    httpsStub.request.returns(requestStub);
    const promise = request({ dropRequestAfter: 500 });
    clock.tick(500);
    return promise.then(fail, error => {
      assert.equal(error.message, "request timeout");
      assert(requestStub.abort.calledOnce);
    });
  });

  it("should not abort the request on request error", () => {
    requestStub.abort = sinon.stub();
    httpsStub.request.returns(requestStub);
    const promise = request({ dropRequestAfter: 500 });
    requestStub.emit("error", new Error("request failed"));
    clock.tick(500);
    return promise.then(fail, () => {
      assert(requestStub.abort.notCalled);
    });
  });

  it("should record timings for non-keep-alive connection", () => {
    const promise = request({ timing: true });
    const socketStub = new SocketStub(true);
    clock.tick(10);
    requestStub.emit("socket", socketStub);
    clock.tick(20);
    socketStub.emit("lookup");
    clock.tick(30);
    socketStub.emit("connect");
    clock.tick(40);
    socketStub.emit("secureConnect");
    clock.tick(50);
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    clock.tick(60);
    responseStub.emit("data", Buffer.from("hello"));
    responseStub.emit("end");
    return promise.then(response => {
      assert.deepEqual(response.timings, {
        socket: 10,
        lookup: 30,
        connect: 60,
        secureConnect: 100,
        response: 150,
        end: 210
      });
      assert.deepEqual(response.timingPhases, {
        wait: 10,
        dns: 20,
        tcp: 30,
        tls: 40,
        firstByte: 50,
        download: 60,
        total: 210
      });
    });
  });

  it("should record timings for keep-alive connection", () => {
    const promise = request({ timing: true });
    const socketStub = new SocketStub(false);
    clock.tick(10);
    requestStub.emit("socket", socketStub);
    clock.tick(20);
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    clock.tick(30);
    responseStub.emit("data", Buffer.from("hello"));
    responseStub.emit("end");
    return promise.then(response => {
      assert.deepEqual(response.timings, {
        socket: 10,
        lookup: 10,
        connect: 10,
        secureConnect: 10,
        response: 30,
        end: 60
      });
      assert.deepEqual(response.timingPhases, {
        wait: 10,
        dns: 0,
        tcp: 0,
        tls: 0,
        firstByte: 20,
        download: 30,
        total: 60
      });
    });
  });

  it("should record timings for timeout", () => {
    requestStub.abort = sinon.stub();
    const responseStub = new ResponseStub();
    responseStub.destroy = sinon.stub();
    const promise = request({ timing: true, dropRequestAfter: 500 });
    const socketStub = new SocketStub(false);
    clock.tick(10);
    requestStub.emit("socket", socketStub);
    clock.tick(90);
    requestStub.emit("response", responseStub);
    clock.tick(100);
    responseStub.emit("data", "hello");
    clock.tick(300);
    return promise.then(fail, error => {
      assert.equal(error.message, "request timeout");
      assert(requestStub.abort.called);
      assert.deepEqual(error.timings, {
        lookup: 10,
        socket: 10,
        connect: 10,
        secureConnect: 10,
        response: 100,
        end: undefined
      });
      assert.deepEqual(error.timingPhases, {
        wait: 10,
        dns: 0,
        tcp: 0,
        tls: 0,
        firstByte: 90,
        download: undefined,
        total: undefined
      });
    });
  });

  it("should log in the span object", () => {
    const logSpy = sinon.spy();
    request({ span: { log: logSpy } });
    const socketStub = new SocketStub(true);
    requestStub.emit("socket", socketStub);
    socketStub.emit("lookup");
    socketStub.emit("connect");
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    responseStub.emit("data", Buffer.from("hello"));
    sinon.assert.calledWith(logSpy, sinon.match.has("socket"));
    sinon.assert.calledWith(logSpy, sinon.match.has("http_response"));
    sinon.assert.calledWith(
      logSpy,
      sinon.match.has("http_response_body_stream")
    );
  });
});
