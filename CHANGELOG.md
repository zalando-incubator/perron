## 0.9.1

* Having a circuit breaker configured no longer results in Node process
not exiting properly.
* Improved circuit breaker performance and memory usage.

## 0.9.0

Added custom error classes for different error types, including ability to distinguish connection timeout error, user timeout error, and maximum retries error. For more details see [Handling Errors section in the README](./README.md#handling-errors)

### Breaking Changes

TypeScript type definition for request headers has been made more
strict to avoid runtime errors caused by `undefined` headers.

See [pull request](https://github.com/zalando-incubator/perron/pull/77/files) for details. 

### Deprecation Notices

Usage of `type` field on `ServiceClientError` to understand the type of the error is now deprecated in favor of `instanceof` checks for new error classes added in this release.

## 0.7.0

### Breaking Changes

In 0.5.0 we changed the exports of the module to be forward-compatible with ES modules. If you are using CommonJS-style require calls, they need to updated from:

```js
const ServiceClient = require('perron')
```

to

```js
const {ServiceClient} = require('perron')
```

So `ServiceClient` is now a named export.

If you were using babel to transpile your code, no changes should be necessary.

## 0.6.0

### Breaking Changes

In 0.6.0 we changed the fields of `timings` and `timingPhases` on `ServiceClientResponse` to be nullable, or `undefined`able to be accurate. Previously `timings` had `-1` when a field was missing, and `timingPhases` had wrong numbers in those cases.
