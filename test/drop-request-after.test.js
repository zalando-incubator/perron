const assert = require("assert");
const nock = require("nock");
const sinon = require("sinon");
const { ServiceClient } = require("../dist/client");

function wait(timeout) {
  return new Promise(resolve => setTimeout(resolve, timeout));
}

const clientOptions = {
  hostname: "catwatch.opensource.zalan.do",
  defaultRequestOptions: {
    dropRequestAfter: 100
  },
  retryOptions: {
    retries: 2,
    retryAfter: 10,
    minTimeout: 0,
    maxTimeout: 0
  }
};

describe("retryAfter option", () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it("Should return retried request response if it arrives first", async () => {
    const successSpy = sinon.spy();
    const failureSpy = sinon.spy();
    const retrySpy = sinon.spy();
    clientOptions.retryOptions.onRetry = retrySpy;

    nock(/catwatch\.opensource\.zalan\.do/)
      .get("/")
      .delay(15)
      .reply(200, `{"foo":"bar-initial"}`)
      .get("/")
      .reply(200, `{"foo":"bar-retry"}`);

    const client = new ServiceClient(clientOptions);

    const requestPending = client
      .request()
      .then(res => {
        assert.equal(JSON.stringify(res.body), `{"foo":"bar-retry"}`);
        successSpy();
      })
      .catch(failureSpy);

    await wait(20);

    sinon.assert.callCount(successSpy, 1);
    sinon.assert.callCount(retrySpy, 1);
    sinon.assert.notCalled(failureSpy);

    return requestPending;
  });

  it("Should return intial request response if it arrives first", async () => {
    const successSpy = sinon.spy();
    const failureSpy = sinon.spy();
    const retrySpy = sinon.spy();
    clientOptions.retryOptions.onRetry = retrySpy;

    nock(/catwatch\.opensource\.zalan\.do/)
      .get("/")
      .delay(15)
      .reply(200, `{"foo":"bar-initial"}`)
      .get("/")
      .delay(20)
      .reply(200, `{"foo":"bar-retry"}`);

    const client = new ServiceClient(clientOptions);

    const requestPending = client
      .request()
      .then(res => {
        assert.equal(JSON.stringify(res.body), `{"foo":"bar-initial"}`);
        successSpy();
      })
      .catch(failureSpy);

    await wait(20);

    sinon.assert.callCount(successSpy, 1);
    sinon.assert.callCount(retrySpy, 1);
    sinon.assert.notCalled(failureSpy);

    return requestPending;
  });

  it("Should also retry initial request with errors without exceeding retry count", async () => {
    const successSpy = sinon.spy();
    const failureSpy = sinon.spy();
    const retrySpy = sinon.spy();
    clientOptions.retryOptions.onRetry = retrySpy;

    nock(/catwatch\.opensource\.zalan\.do/)
      .get("/")
      .reply(500, `{"foo":"bar"}`)
      .get("/")
      .delay(20)
      .reply(200, `{"foo":"bar1"}`)
      .get("/")
      .reply(200, `{"foo":"bar2"}`);

    const client = new ServiceClient(clientOptions);

    const requestPending = client
      .request()
      .then(res => {
        assert.equal(JSON.stringify(res.body), `{"foo":"bar2"}`);
        successSpy();
      })
      .catch(failureSpy);

    await wait(30);

    sinon.assert.callCount(successSpy, 1);
    sinon.assert.callCount(retrySpy, 2);
    sinon.assert.notCalled(failureSpy);

    return requestPending;
  });

  it("Should also retry retried request with errors without exceeding retry count", async () => {
    const successSpy = sinon.spy();
    const failureSpy = sinon.spy();
    const retrySpy = sinon.spy();
    clientOptions.retryOptions.onRetry = retrySpy;

    nock(/catwatch\.opensource\.zalan\.do/)
      .get("/")
      .delay(20)
      .reply(200, `{"foo":"bar"}`)
      .get("/")
      .reply(500, `{"foo":"bar1"}`)
      .get("/")
      .reply(200, `{"foo":"bar2"}`);

    const client = new ServiceClient(clientOptions);

    const requestPending = client
      .request()
      .then(res => {
        assert.equal(JSON.stringify(res.body), `{"foo":"bar2"}`);
        successSpy();
      })
      .catch(failureSpy);

    await wait(30);

    sinon.assert.callCount(successSpy, 1);
    sinon.assert.callCount(retrySpy, 2);
    sinon.assert.notCalled(failureSpy);

    return requestPending;
  });
});
