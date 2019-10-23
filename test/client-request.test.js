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
          dropRequestAfter: 800
        },
        retryOptions: {
          retries: 2,
          retryAfter: 100,
          onRetry: retrySpy,
          minTimeout: 0,
          maxTimeout: 0
        }
      };

      nock(/catwatch\.opensource\.zalan\.do/)
        .get("/")
        .delay(250)
        .reply(500, `{"foo":"bar"}`)
        .get("/")
        .delay(150)
        .reply(500, `{"foo":"bar1"}`)
        .get("/")
        .reply(200, `{"foo":"bar2"}`);

      const client = new ServiceClient(clientOptions);
      const responsePending = client.request();

      responsePending.then(res => {
        assert.equal(JSON.stringify(res.body), `{"foo":"bar2"}`);
      });

      await wait(300);

      assert.equal(retrySpy.callCount, 2);

      return responsePending;
    });

    it("Should start retrying after retryAfter timer", async () => {
      const retrySpy = sinon.spy();
      const clientOptions = {
        hostname: "catwatch.opensource.zalan.do",
        defaultRequestOptions: {
          dropRequestAfter: 800
        },
        retryOptions: {
          retries: 2,
          retryAfter: 100,
          onRetry: retrySpy,
          minTimeout: 0,
          maxTimeout: 0
        }
      };

      nock(/catwatch\.opensource\.zalan\.do/)
        .get("/")
        .delay(150)
        .reply(200, `{"foo":"bar"}`)
        .get("/")
        .reply(200, `{"foo":"bar1"}`);

      const client = new ServiceClient(clientOptions);
      const responsePending = client.request();

      let index = 0;
      responsePending.then(() => {
        assert.equal(index, 0);
        index++;
      });

      await wait(300);

      const flushPromises = () => new Promise(resolve => setImmediate(resolve));
      await flushPromises();

      assert.equal(retrySpy.callCount, 1);

      return responsePending;
    });
  });
});
