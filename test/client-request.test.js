const assert = require("assert");
const nock = require("nock");
const sinon = require("sinon");
const { ServiceClient, RequestUserTimeoutError } = require("../dist/client");

function wait(timeout) {
  return new Promise(resolve => setTimeout(resolve, timeout));
}

describe("Client - request integration tests", () => {
  describe("dropAllRequestsAfter option", () => {
    it("Should drop all requests after dropAllRequestsAfter timer", () => {
      const clientOptions = {
        hostname: "catwatch.opensource.zalan.do",
        dropAllRequestsAfter: 100
      };
      const client = new ServiceClient(clientOptions);

      nock(/catwatch\.opensource\.zalan\.do/)
        .get("/")
        .delay(200)
        .reply(200, `{"foo":"bar"}`);

      return assert.rejects(client.request(), RequestUserTimeoutError);
    });
  });

  describe("retryAfter option", () => {
    it("Should start retrying after retryAfter timer", async () => {
      const retrySpy = sinon.spy();

      const clientOptions = {
        hostname: "catwatch.opensource.zalan.do",
        defaultRequestOptions: {
          dropRequestAfter: 200
        },
        retryOptions: {
          retries: 2,
          retryAfter: 100,
          onRetry: retrySpy
        }
      };

      nock(/catwatch\.opensource\.zalan\.do/)
        .get("/")
        .delay(300)
        .reply(200, `{"foo":"bar"}`)
        .get("/")
        .reply(200, `{"foo":"bar"}`);

      const client = new ServiceClient(clientOptions);
      const responsePending = client.request();

      await wait(150);
      assert.equal(retrySpy.callCount, 1);

      return responsePending;
    });
  });
});
