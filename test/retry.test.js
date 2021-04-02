const { operation, timeouts } = require("../dist/retry");
const assert = require("assert");
const sinon = require("sinon");

const baseOptions = {
  retries: 10,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 10000000,
  randomize: false
};

describe("Retry", function() {
  let clock;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it("should attempt the operation", () => {
    const fn = sinon.spy();
    const op = operation(baseOptions, fn);
    op.attempt();
    sinon.assert.called(fn);
  });

  it("should retry a failed operation", done => {
    let attempts = 0;
    const op = operation({ ...baseOptions, retries: 3 }, () => {
      attempts++;
      const currentAttempt = op.retry();
      if (currentAttempt) {
        assert.equal(currentAttempt, attempts);
        clock.tick(baseOptions.maxTimeout);
        return;
      }
      assert.strictEqual(attempts, 4);
      done();
    });
    op.attempt();
  });

  it("should retry immediately an operation when retry is called with immediate=true", () => {
    const fn = sinon.spy();
    const op = operation(baseOptions, fn);
    op.retry();
    sinon.assert.notCalled(fn);
    op.retry(true);
    sinon.assert.called(fn);
  });

  describe("timeout generation", () => {
    it("should work with default values", () => {
      const calculatedTimeouts = timeouts(baseOptions);

      assert.equal(calculatedTimeouts.length, 10);
      assert.equal(calculatedTimeouts[0], 1000);
      assert.equal(calculatedTimeouts[1], 2000);
      assert.equal(calculatedTimeouts[2], 4000);
    });
    it("should work with randomize", () => {
      const minTimeout = 5000;
      const calculatedTimeouts = timeouts({
        ...baseOptions,
        minTimeout: minTimeout,
        randomize: true
      });

      assert.equal(calculatedTimeouts.length, 10);
      assert.ok(calculatedTimeouts[0] > minTimeout);
      assert.ok(calculatedTimeouts[1] > calculatedTimeouts[0]);
      assert.ok(calculatedTimeouts[2] > calculatedTimeouts[1]);
    });
    it("should work with limits", () => {
      const minTimeout = 1000;
      const maxTimeout = 10000;
      const calculatedTimeouts = timeouts({
        ...baseOptions,
        minTimeout,
        maxTimeout
      });

      for (let i = 0; i < calculatedTimeouts.length; i++) {
        assert.ok(calculatedTimeouts[i] >= minTimeout);
        assert.ok(calculatedTimeouts[i] <= maxTimeout);
      }
    });
    it("should have incremental timeouts", () => {
      const calculatedTimeouts = timeouts(baseOptions);
      let lastTimeout = calculatedTimeouts[0];
      for (let i = 1; i < calculatedTimeouts.length; i++) {
        assert.ok(calculatedTimeouts[i] > lastTimeout);
        lastTimeout = calculatedTimeouts[i];
      }
    });
    it("should have incremental timeouts for factors less than one", () => {
      const calculatedTimeouts = timeouts({
        ...baseOptions,
        retries: 3,
        factor: 0.5
      });
      assert.deepEqual([250, 500, 1000], calculatedTimeouts);
    });
  });
});
