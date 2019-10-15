const assert = require("assert");
const nock = require("nock");
const { ServiceClient, RequestUserTimeoutError } = require("../dist/client");

describe("Client - request integration tests", () => {
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
