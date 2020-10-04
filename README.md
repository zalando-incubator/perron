[![Build Status](https://github.com/zalando-incubator/perron/workflows/CI/badge.svg?branch=master)](https://github.com/zalando-incubator/perron/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# Perron

A sane client for web services with a built-in circuit-breaker, support for filtering both request and response.
```
npm install perron --save
```

**[Changelog](https://github.com/zalando-incubator/perron/blob/master/CHANGELOG.md)**

## Quick Example

The following is a minimal example of using `perron` to call a web service:

```js
const {ServiceClient} = require('perron');

// A separate instance of `perron` is required per host
const catWatch = new ServiceClient('https://catwatch.opensource.zalan.do');

catWatch.request({
    pathname: '/projects',
    query: {
        limit: 10
    }
}).then(data => console.log(data));
```

## Making Requests

Each call to `request` method will return a Promise, that would either resolve to a successful `ServiceClient.Response` containing following fields:

```js
{
    statusCode, // same as Node IncomingMessage.statusCode
    headers, // same as Node IncomingMessage.headers
    body // if JSON, then parsed body, otherwise a string
}
```

`request` method accepts an objects with all of the same properties as [https.request](https://nodejs.org/api/https.html#https_https_request_options_callback) method in Node.js, except from a `hostname` field, which is taken from the options passed when creating an instance of `ServiceClient`. Additionally you can add a `timeout` and `readTimeout` fields, which define time spans in ms for socket connection and read timeouts.

## Handling Errors

For the error case you will get a custom error type `ServiceClientError`. A custom type is useful in case you change the request to some other processing in your app and then need to distinguish between your app error and requests errors in a final catch.

`ServiceClientError` class contains an optional `response` field that is available if any response was received before there was an error.

If you have not specified retry options, you can use `instanceof` checks on the error to determine exact reason:

```js
catWatch.request({
  path: '/projects?limit=10'
}).then(console.log, logError);

function logError(err) {
  if (err instanceof BodyParseError) {
    console.log('Got a JSON response but parsing it failed');
    console.log('Raw response was', err.response);
  } else if (err instanceof RequestFilterError) {
    console.log('Request filter failed');
  } else if (err instanceof ResponseFilterError) {
    console.log('Response filter failed');
    console.log('Raw response was', err.response);
  } else if (err instanceof CircuitOpenError) {
    console.log('Circuit breaker is open');
  } else if (err instanceof RequestConnectionTimeoutError) {
    console.log('Connection timeout');
    console.log('Request options were', err.requestOptions);
  } else if (err instanceof RequestReadTimeoutError) {
    console.log('Socket read timeout');
    console.log('Request options were', err.requestOptions);
  } else if (err instanceof RequestUserTimeoutError) {
    console.log('Request dropped after timeout specified in `dropRequestAfter` option');
    console.log('Request options were', err.requestOptions);
  } else if (err instanceof RequestNetworkError) {
    console.log('Network error (socket, dns, etc.)');
    console.log('Request options were', err.requestOptions);
  } else if (err instanceof InternalError) {
    // This error should not happen during normal operations
    // and usually indicates a bug in perron or misconfiguration
    console.log('Unknown internal error');
  }
}
```

If you have retries configured, there are only 3 types of errors you will get that are relating to circuit breakers and retries, however you can access original errors that led to retries through `retryErrors` field available on both the successful response:

```js

catWatch.request({
  path: '/projects?limit=10'
}).then(function (result) {
  console.log("Response was", result.body);
  if (result.retryErrors.length) {
    console.log("Request successful, but there were retries:");
    result.retryErrors.forEach(logError);
  }
}, logError);

function logRetryError(err) {
  if (err instanceof CircuitOpenError) {
    console.log('Circuit breaker is open');
  } else if (err instanceof ShouldRetryRejectedError) {
    console.log('Provided `shouldRetry` function rejected retry attempt');
    err.retryErrors.forEach(logError);
  } else if (err instanceof MaximumRetriesReachedError) {
    console.log('Reached maximum retry count');
    err.retryErrors.forEach(logError);
  }
}
```

## Circuit Breaker

It's almost always a good idea to have a circuit breaker around your service calls, and generally one per hostname is also a good default since 5xx usually means something is wrong with the whole service and not a specific endpoint.

This is why `perron` by default includes one circuit breaker per instance. Internally `perron` uses [circuit-breaker-js](https://github.com/yammer/circuit-breaker-js), so you can use all of it's options when configuring the breaker:

```js
const {ServiceClient} = require('perron');

const catWatch = new ServiceClient({
    hostname: 'catwatch.opensource.zalan.do',
    // If the "circuitBreaker" settings are passed (non-falsy), they will be merged
    // with the default options below. Otherwise, circuit breaking will be disabled
    circuitBreaker: {
        windowDuration: 10000,
        numBuckets: 10,
        timeoutDuration: 2000,
        errorThreshold: 50,
        volumeThreshold: 10
    }
});
```

Optionally the `onCircuitOpen` and `onCircuitClose` functions can be passed to the circuitBreaker object in order to track the state of the circuit breaker via metrics or logging:

```js
const catWatch = new ServiceClient({
    hostname: 'catwatch.opensource.zalan.do',
    circuitBreaker: {
        windowDuration: 10000,
        numBuckets: 10,
        timeoutDuration: 2000,
        errorThreshold: 50,
        volumeThreshold: 10,
        onCircuitOpen: (metrics) => {
          console.log('Circuit breaker open', metrics);
        },
        onCircuitClose: (metrics) => {
          console.log('Circuit breaker closed', metrics);
        }
    }
});
```

Circuit breaker will count all errors, including the ones coming from filters, so it's generally better to do pre- and post- validation of your request outside of filter chain.

If this is not the desired behavior, or you are already using a circuit breaker, it's always possible to disable the built-in one:

```js
const catWatch = new ServiceClient({
    hostname: 'catwatch.opensource.zalan.do',
    circuitBreaker: false
});
```

In case if you want perron to still use a circuit breaker but it has to be provided dynamically by your code on-demand you can pass `circuitBreaker` option as a function (make sure to _not_ create a circuit breaker for every request):

```js
const catWatch = new ServiceClient({
    hostname: 'catwatch.opensource.zalan.do',
    circuitBreaker: function (request) {
      return somePreviouslyConstructedCB;
    }
});
```

## Retry Logic

For application critical requests it can be a good idea to retry failed requests to the responsible services.

Occasionally target server can have high latency for a short period of time, or in the case of a stack of servers, one server can be having issues
and retrying the request will allow perron to attempt to access one of the other servers that currently aren't facing issues.

By default `perron` has retry logic implemented, but configured to perform 0 retries. Internally `perron` uses [node-retry](https://github.com/tim-kos/node-retry) to handle the retry logic and configuration. All of the existing options provided by `node-retry` can be passed via configuration options through `perron`.

There is a `shouldRetry` function which can be defined in any way by the consumer and is used in the try logic to determine whether to attempt the retries or not depending on the type of error and the original request object.
If the function returns true and the number of retries hasn't been exceeded, the request can be retried.

There is also an `onRetry` function which can be defined by the user of `perron`. This function is called every time a retry request will be triggered.
It is provided the current attempt index, the error that is causing the retry and the original request params.

The first time `onRetry` gets called, the value of currentAttempt will be 2. This is because the first initial request is counted as the first attempt, and the first retry attempted will then be the second request.

```js
const {ServiceClient} = require('perron');

const catWatch = new ServiceClient({
    hostname: 'catwatch.opensource.zalan.do',
    retryOptions: {
        retries: 1,
        factor: 2,
        minTimeout: 200,
        maxTimeout: 400,
        randomize: true,
        shouldRetry(err, req) {
            return (err && err.response && err.response.statusCode >= 500);
        },
        onRetry(currentAttempt, err, req) {
            console.log('Retry attempt #' + currentAttempt + ' for ' + req.path + ' due to ' + err);
        }
    }
});
```

## Filters

It's quite often necessary to do some pre- or post-processing of the request. For this purpose `perron` implements a concept of filters, that are just an object with 2 optional methods: `request` and `response`.

By default, every instance of `perron` includes a `treat5xxAsError` filter, but you can specify which filters should be use by providing a `filters` options when constructing an instance. This options expects an array of filter object and is *not* automatically merged with the default ones, so be sure to use `concat` if you want to keep the default filters as well.

There aren't separate request and response filter chains, so given that we have filters `A`, `B` and `C` the request flow will look like this:

```
A.request ---> B.request ---> C.request ---|
                                           V
                                      HTTP Request
                                           |
A.response <-- B.response <-- C.response <--
```

If corresponding `request` or `response` method is missing in the filter, it is skipped, and the flow goes to the next one.

### Modifying the Request

Let's say that we want to inject a custom header of the request. This is really easy to do in a request filter:

```js
const {ServiceClient} = require('perron');

// A separate instance of ServiceClient is required per host
const catWatch = new ServiceClient({
    hostname: 'catwatch.opensource.zalan.do',
    filters: [{
        request(request) {
            // let's pretend to be AJAX
            request.headers['x-requested-with'] = 'XMLHttpRequest';
            return request;
        }
    }, ServiceClient.treat5xxAsError]
});
```

### Resolving Request in a Filter

Sometimes it is necessary to pretend to have called the service without actually doing it. This could be useful for caching, and is also very easy to implement:

```js
const {ServiceClient} = require('perron');

const getCache = require('./your-module-with-cache');

// A separate instance of ServiceClient is required per host
const catWatch = new ServiceClient({
    hostname: 'catwatch.opensource.zalan.do',
    filters: [{
        request(request) {
            const body = getCache(request);
            if (body) {
                const headers = {};
                const statusCode = 200;
                return new ServiceClient.Response(
                    statusCode, headers, body
                );
            }
            return request;
        }
    }, ServiceClient.treat5xxAsError]
});
```

If the request is resolved in such a way, all of the pending filter in the request and response chain will be skipped, so the flow diagram will look like this:

```
   called     |    not called
---------------------------------
 cacheFilter  |  B.treat5xxAsError
      |       |
      |       |    HTTP Request
      V       |
 cacheFilter  |  B.treat5xxAsError
```

### Rejecting Request in a Filter

It is possible to reject the request both in request and response filters by throwing, or by returning a rejected Promise. Doing so will be picked up by the circuit breaker, so this behavior should be reserved by the cases where the service returns `5xx` error, or the response is completely invalid (e.g. invalid JSON).

### JSON Parsing

By default Perron will try to parse JSON body if the `content-type` header is not set or
it is specified as `application/json`. If you wish to disable this behavior you can use
`autoParseJson: false` option when constructing `ServiceClient` object.

### UTF-8 Decoding
By default Perron will try to decode JSON body to UTF-8 string.
If you wish to disable this behaviour, you can use `autoDecodeUtf8: false` option
when calling `request` method.

### Opentracing

Perron accepts a Span like object where it will log the network and request related events.

## License

The MIT License

Copyright (c) 2016 Zalando SE

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.


