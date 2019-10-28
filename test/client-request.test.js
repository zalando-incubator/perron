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
        dropAllRequestsAfter: 10
      };
      const client = new ServiceClient(clientOptions);

      nock(/catwatch\.opensource\.zalan\.do/)
        .get("/")
        .delay(20)
        .reply(200, `{"foo":"bar"}`);

      return assert.rejects(client.request(), RequestUserTimeoutError);
    });

    it("Should drop all requests after dropAllRequestsAfter timer including retries", async () => {
      const retrySpy = sinon.spy();
      const successSpy = sinon.spy();
      const failureSpy = sinon.spy();
      const clientOptions = {
        hostname: "catwatch.opensource.zalan.do",
        dropAllRequestsAfter: 40,
        retryOptions: {
          retries: 2,
          retryAfter: 10,
          onRetry: retrySpy
        }
      };
      const client = new ServiceClient(clientOptions);
      const responsePending = client
        .request()
        .then(() => {
          successSpy();
        })
        .catch(err => {
          failureSpy();
          assert(err instanceof ServiceClient.Error);
          assert(err instanceof RequestUserTimeoutError);
        });

      nock(/catwatch\.opensource\.zalan\.do/)
        .get("/")
        .delay(50)
        .reply(200, `{"foo":"bar"}`)
        .get("/")
        .delay(50)
        .reply(200, `{"foo":"bar"}`)
        .get("/")
        .delay(50)
        .reply(200, `{"foo":"bar"}`);

      await wait(50);

      sinon.assert.callCount(retrySpy, 2);
      sinon.assert.notCalled(successSpy);
      sinon.assert.callCount(failureSpy, 1);
      return responsePending;
    });
  });

  describe("retryAfter option", () => {
    it("Should start retrying after retryAfter timer", async () => {
      const retrySpy = sinon.spy();
      const clientOptions = {
        hostname: "catwatch.opensource.zalan.do",
        defaultRequestOptions: {
          dropRequestAfter: 100
        },
        retryOptions: {
          retries: 2,
          retryAfter: 10,
          onRetry: retrySpy
        }
      };

      nock(/catwatch\.opensource\.zalan\.do/)
        .get("/")
        .delay(25)
        .reply(500, `{"foo":"bar"}`)
        .get("/")
        .delay(15)
        .reply(500, `{"foo":"bar1"}`)
        .get("/")
        .reply(200, `{"foo":"bar2"}`);

      const client = new ServiceClient(clientOptions);
      const responsePending = client.request();

      await wait(40);

      responsePending.then(res => {
        assert.equal(JSON.stringify(res.body), `{"foo":"bar2"}`);
      });

      assert.equal(retrySpy.callCount, 2);
      return responsePending;
    });

    it("Should caputre initial response if it comes before retry", async () => {
      const retrySpy = sinon.spy();
      const clientOptions = {
        hostname: "catwatch.opensource.zalan.do",
        defaultRequestOptions: {
          dropRequestAfter: 100
        },
        retryOptions: {
          retries: 2,
          retryAfter: 10,
          onRetry: retrySpy,
          minTimeout: 0,
          maxTimeout: 0
        }
      };

      nock(/catwatch\.opensource\.zalan\.do/)
        .get("/")
        .delay(15)
        .reply(200, `{"foo":"bar"}`)
        .get("/")
        .delay(20)
        .reply(200, `{"foo":"bar1"}`);

      const client = new ServiceClient(clientOptions);
      const responsePending = client.request();

      let index = 0;
      responsePending.then(res => {
        assert.equal(JSON.stringify(res.body), `{"foo":"bar"}`);
        assert.equal(index, 0);
        index++;
      });

      await wait(20);

      assert.equal(retrySpy.callCount, 1);
      return responsePending;
    });
  });
});
