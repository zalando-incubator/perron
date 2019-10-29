const assert = require("assert");
const nock = require("nock");
const sinon = require("sinon");
const { ServiceClient, RequestUserTimeoutError } = require("../dist/client");

function wait(timeout) {
  return new Promise(resolve => setTimeout(resolve, timeout));
}

describe("dropAllRequestsAfter option", () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it("Should drop all requests after dropAllRequestsAfter timer including retries", async () => {
    const successSpy = sinon.spy();
    const failureSpy = sinon.spy();
    const retrySpy = sinon.spy();
    const clientOptions = {
      hostname: "catwatch.opensource.zalan.do",
      dropAllRequestsAfter: 40,
      retryOptions: {
        retries: 2,
        retryAfter: 10,
        minTimeout: 0,
        maxTimeout: 0,
        onRetry: retrySpy
      }
    };

    nock(/catwatch\.opensource\.zalan\.do/)
      .get("/")
      .delay(45)
      .reply(200, `{"foo":"bar"}`)
      .get("/")
      .delay(45)
      .reply(200, `{"foo":"bar"}`)
      .get("/")
      .delay(45)
      .reply(200, `{"foo":"bar"}`);

    const requestPending = new ServiceClient(clientOptions)
      .request()
      .then(successSpy)
      .catch(err => {
        failureSpy();
        assert(err instanceof ServiceClient.Error);
        assert(err instanceof RequestUserTimeoutError);
      });

    await wait(50);

    sinon.assert.notCalled(successSpy);
    sinon.assert.callCount(failureSpy, 1);
    sinon.assert.callCount(retrySpy, 2);

    return requestPending;
  });
});
