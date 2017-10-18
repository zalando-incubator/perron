[![Build Status](https://travis-ci.org/zalando-incubator/perron.svg?branch=master)](https://travis-ci.org/zalando-incubator/perron)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# Perron

A sane client for web services with a built-in circuit-breaker, support for filtering both request and response.

## Quick Example

The following is a minimal example of using `perron` to call a web service:

```js
const ServiceClient = require('perron');

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

`request` method accepts an objects with all of the same properties as [https.request](https://nodejs.org/api/https.html#https_https_request_options_callback) method in Node.js, except from a `hostname` field, which is taken from the options passed when creating an instance of `ServiceClient`. Additionally you can add a `dropRequestAfter` field, which defines a timespan in ms after which the request is dropped and the promise is rejected with a `request timeout` error.

## Handling Errors

For the error case you will get a custom error type `ServiceClient.Error`. A custom type is useful in case you change the request to some other processing in your app and then need to distinguish between your app error and requests errors in a final catch.

An instance of `ServiceClient.Error` also carries additional information on type of the error:

```js
catWatch.request({
    path: '/projects?limit=10'
}).then(
    data => console.log(data),
    dealWithError
);

function dealWithError(err) {
    switch (err.type) {
        case ServiceClient.REQUEST_FAILED:
            console.log('HTTP Request failed');
            break;
        case ServiceClient.BODY_PARSE_FAILED:
            console.log('Got a JSON response but parsing it failed');
            break;

        case ServiceClient.REQUEST_FILTER_FAILED:
            console.log('A request filter rejected the request');
            break;
        case ServiceClient.RESPONSE_FILTER_FAILED:
            console.log('A response filter rejected the request');
            break;

        case ServiceClient.CIRCUIT_OPEN:
            console.log('Circuit breaker is open');
            break;
    }
}
```

Final useful feature of the `ServiceClient.Error` class is an optional `response` field that is available if any response was received before there was an error.

## Circuit Breaker

It's almost always a good idea to have a circuit breaker around your service calls, and generally one per hostname is also a good default since 5xx usually means something is wrong with the whole service and not a specific endpoint.

This is why `perron` by default includes one circuit breaker per instance. Internally `perron` uses [circuit-breaker-js](https://github.com/yammer/circuit-breaker-js), so you can use all of it's options when configuring the breaker:

```js
const ServiceClient = require('perron');

const catWatch = new ServiceClient({
    hostname: 'catwatch.opensource.zalan.do',
    // These are the default settings
    circuitBreaker: {
        windowDuration: 10000,
        numBuckets: 10,
        timeoutDuration: 2000,
        errorThreshold: 50,
        volumeThreshold: 10
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

## Retry Logic

For application critical requests it can be a good idea to retry failed requests to the responsible services.

Occasionaly target server can have high latency for a short period of time, or in the case of a stack of servers, one server can be having issues
and retrying the request will allow perron to attempt to access one of the other servers that currently aren't facing issues.

By default `perron` has retry logic implemented, but configured to perform 0 retries. Internally `perron` uses [node-retry](https://github.com/tim-kos/node-retry) to handle the retry logic
and configuration. All of the existing options provided by `node-retry` can be passed via configuration options through `perron`.

There is a shouldRetry function which can be defined in any way by the consumer and is used in the try logic to determine whether to attempt the retries or not depending on the type of error and the original request object. 
If the function returns true and the number of retries hasn't been exceeded, the request can be retried.

There is also an onRetry function which can be defined by the user of `perron`. This function is called every time a retry request will be triggered.
It is provided the currentAttempt, the error that is causing the retry and the original request params.

The first time onRetry gets called, the value of currentAttempt will be 2. This is because the first initial request is counted as the first attempt, and the first retry attempted will then be the second request.

```js
const ServiceClient = require('perron');

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
const ServiceClient = require('perron');

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
const ServiceClient = require('perron');

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


