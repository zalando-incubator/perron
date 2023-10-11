## 0.11.5
* use ServiceClientError type for Errors in shouldRetry and onRetry options.

## 0.11.3

* Use `timing` option from client if `timing` is not set in the request options. #91
* Improved TypeScript definition of `ServiceClientRequestFilter`. #100

## 0.11.2

* Fixed an error that is thrown when `dropRequestAfter` is set and a connection error happens. #96

## 0.11.1

* Added support for measuring TLS timings.

## 0.11.0

* Added `span` option where the tcp events will be logged. The interface matches the opentracing span interface.
* Improved retries performance and memory usage.

## 0.10.0

* Added `readTimeout` options to be able to timeout when a socket is
idle for a certain period of time.

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
