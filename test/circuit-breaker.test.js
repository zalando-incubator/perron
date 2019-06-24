const { CircuitBreaker } = require("../dist/circuit-breaker");
const assert = require("assert");
const sinon = require("sinon");

describe("CircuitBreaker", function() {
  let breaker;
  let clock;

  const success = function() {
    const command = function(success) {
      success();
    };

    breaker.run(command);
  };

  const fail = function() {
    const command = function(success, failed) {
      failed();
    };

    breaker.run(command);
  };

  const timeout = function() {
    const command = function() {};
    breaker.run(command);

    clock.tick(1000);
    clock.tick(1000);
    clock.tick(1000);
  };

  beforeEach(function() {
    clock = sinon.useFakeTimers();
    breaker = new CircuitBreaker();
  });

  afterEach(function() {
    clock.restore();
  });

  describe("with a working service", function() {
    it("should run the command", function() {
      const command = sinon.spy();
      breaker.run(command);

      sinon.assert.called(command);
    });

    it("should be able to notify the breaker if the command was successful", function() {
      success();

      const bucket = breaker.lastBucket();
      assert.strictEqual(bucket.successes, 1);
    });

    it("should be able to notify the breaker if the command failed", function() {
      fail();

      const bucket = breaker.lastBucket();
      assert.strictEqual(bucket.failures, 1);
    });

    it("should record a timeout if not a success or failure", function() {
      timeout();

      const bucket = breaker.lastBucket();
      assert.strictEqual(bucket.timeouts, 1);
    });

    it("should not call timeout if there is a success", function() {
      success();

      clock.tick(1000);
      clock.tick(1000);
      clock.tick(1000);

      const bucket = breaker.lastBucket();
      assert.strictEqual(bucket.timeouts, 0);
    });

    it("should not call timeout if there is a failure", function() {
      fail();

      clock.tick(1000);
      clock.tick(1000);
      clock.tick(1000);

      const bucket = breaker.lastBucket();
      assert.strictEqual(bucket.timeouts, 0);
    });

    it("should not record a success when there is a timeout", function() {
      const command = function(success) {
        clock.tick(1000);
        clock.tick(1000);
        clock.tick(1000);

        success();
      };

      breaker.run(command);

      const bucket = breaker.lastBucket();
      assert.strictEqual(bucket.successes, 0);
    });

    it("should not record a failure when there is a timeout", function() {
      const command = function(success, fail) {
        clock.tick(1000);
        clock.tick(1000);
        clock.tick(1000);

        fail();
      };

      breaker.run(command);

      const bucket = breaker.lastBucket();
      assert.strictEqual(bucket.failures, 0);
    });
  });

  describe("with a broken service", function() {
    beforeEach(function() {
      sinon.stub(breaker, "isOpen").returns(true);
    });

    it("should not run the command", function() {
      const command = sinon.spy();
      breaker.run(command);

      sinon.assert.notCalled(command);
    });

    it("should run the fallback if one is provided", function() {
      const command = sinon.spy();
      const fallback = sinon.spy();

      breaker.run(command, fallback);

      sinon.assert.called(fallback);
    });

    it("should record a short circuit", function() {
      const command = sinon.spy();
      breaker.run(command);

      sinon.assert.notCalled(command);

      const bucket = breaker.lastBucket();
      assert.strictEqual(bucket.shortCircuits, 1);
    });
  });

  describe("isOpen", function() {
    it("should be false if errors are below the threshold", function() {
      breaker.errorThreshold = 75;

      fail();
      fail();
      fail();
      success();

      assert.strictEqual(breaker.isOpen(), false);
    });

    it("should be true if errors are above the threshold", function() {
      breaker.errorThreshold = 75;

      fail();
      fail();
      fail();
      fail();
      fail();
      success();

      assert.strictEqual(breaker.isOpen(), true);
    });

    it("should be true if timeouts are above the threshold", function() {
      breaker.errorThreshold = 25;
      breaker.volumeThreshold = 1;

      timeout();
      timeout();
      success();

      assert.strictEqual(breaker.isOpen(), true);
    });

    it("should maintain failed state after window has passed", function() {
      breaker.errorThreshold = 25;
      breaker.volumeThreshold = 1;

      fail();
      fail();
      fail();
      fail();

      clock.tick(11001);

      fail();

      assert.strictEqual(breaker.isOpen(), true);
    });

    it("should retry after window has elapsed", function() {
      fail();
      fail();
      fail();
      fail();

      clock.tick(11001);

      const command = sinon.spy();
      breaker.run(command);

      sinon.assert.called(command);
    });

    it("should include errors within the current time window", function() {
      breaker.errorThreshold = 75;

      fail();
      fail();
      fail();
      fail();
      fail();
      success();

      clock.tick(1001);

      assert.strictEqual(breaker.isOpen(), true);
    });

    it("should not be broken without having more than minimum number of errors", function() {
      breaker.errorThreshold = 25;
      breaker.volumeThreshold = 1;

      fail();

      assert.strictEqual(breaker.isOpen(), false);
    });
  });

  describe("logging", function() {
    let openSpy;
    let closeSpy;

    beforeEach(function() {
      openSpy = sinon.spy();
      closeSpy = sinon.spy();

      breaker.volumeThreshold = 1;
      breaker.onCircuitOpen = openSpy;
      breaker.onCircuitClose = closeSpy;
    });

    it("should call the onCircuitOpen method when a failure is recorded", function() {
      fail();
      fail();

      sinon.assert.called(openSpy);
    });

    it("should call the onCircuitClosed method when the break is successfully reset", function() {
      fail();
      fail();
      fail();
      fail();

      clock.tick(11001);

      success();

      sinon.assert.called(closeSpy);
    });
  });

  describe("forceClose", function() {
    it("should bypass threshold checks", function() {
      fail();
      fail();
      fail();
      fail();
      fail();
      fail();

      breaker.forceClose();

      const command = sinon.spy();
      breaker.run(command);

      sinon.assert.called(command);
      assert.strictEqual(breaker.isOpen(), false);
    });

    it("should not collect stats", function() {
      fail();
      fail();
      fail();
      fail();
      fail();
      fail();

      breaker.forceClose();
      success();
      success();
      success();
      success();
      success();

      const command = sinon.spy();
      breaker.run(command);

      sinon.assert.called(command);
      assert.strictEqual(breaker.isOpen(), false);
    });
  });

  describe("forceOpen", function() {
    it("should bypass threshold checks", function() {
      success();
      success();
      success();
      success();
      success();
      success();

      breaker.forceOpen();

      const command = sinon.spy();
      breaker.run(command);

      sinon.assert.notCalled(command);
      assert.strictEqual(breaker.isOpen(), true);
    });

    it("should not collect stats", function() {
      success();
      success();
      success();
      success();
      success();
      success();

      breaker.forceOpen();
      fail();
      fail();
      fail();
      fail();
      fail();

      const command = sinon.spy();
      breaker.run(command);

      sinon.assert.notCalled(command);
      assert.strictEqual(breaker.isOpen(), true);
    });
  });

  describe("unforce", function() {
    it("should recover from a force-closed circuit", function() {
      fail();
      fail();
      fail();
      fail();
      fail();
      fail();

      breaker.forceClose();
      breaker.unforce();

      const command = sinon.spy();
      breaker.run(command);

      sinon.assert.notCalled(command);
      assert.strictEqual(breaker.isOpen(), true);
    });

    it("should recover from a force-open circuit", function() {
      success();
      success();
      success();
      success();
      success();
      success();

      breaker.forceOpen();
      breaker.unforce();

      const command = sinon.spy();
      breaker.run(command);

      sinon.assert.called(command);
      assert.strictEqual(breaker.isOpen(), false);
    });
  });
});
