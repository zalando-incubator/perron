import {
  IncomingHttpHeaders,
  IncomingMessage,
  request as httpRequest
} from "http";
import { request as httpsRequest, RequestOptions } from "https";
import * as querystring from "querystring";
import * as zlib from "zlib";

const getInterval = (time: [number, number]): number => {
  const diff = process.hrtime(time);
  return Math.round(diff[0] * 1000 + diff[1] / 1000000);
};

/**
 * The NodeJS typescript definitions has OutgoingHttpHeaders
 * with `undefined` as one of the possible values, but NodeJS
 * runtime will throw an error for undefined values in headers.
 *
 * This overwrites the headers type in the RequestOptions
 * and removes undefined from one of the possible values of headers.
 */
export interface OutgoingHttpHeaders {
  [header: string]: number | string | string[];
}

export interface ServiceClientRequestOptions extends RequestOptions {
  pathname: string;
  query?: object;
  timing?: boolean;
  dropRequestAfter?: number;
  body?: any;
  headers?: OutgoingHttpHeaders;
}

export class ServiceClientResponse {
  public timings?: Timings;
  public timingPhases?: TimingPhases;
  constructor(
    public statusCode: number,
    public headers: IncomingHttpHeaders,
    public body: any,
    public request: ServiceClientRequestOptions
  ) {}
}

export interface Timings {
  lookup?: number;
  socket?: number;
  connect?: number;
  response?: number;
  end?: number;
}
export interface TimingPhases {
  wait?: number;
  dns?: number;
  tcp?: number;
  firstByte?: number;
  download?: number;
  total?: number;
}

const subtract = (a?: number, b?: number): number | undefined => {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return undefined;
};

export class RequestError extends Error {
  public timings?: Timings;
  public timingPhases?: TimingPhases;
  public requestOptions: ServiceClientRequestOptions;
  constructor(
    message: string,
    requestOptions: ServiceClientRequestOptions,
    timings?: Timings
  ) {
    super(message);
    this.requestOptions = requestOptions;
    this.timings = timings;
    this.timingPhases = timings && makeTimingPhases(timings);
  }
}

export class ConnectionTimeoutError extends RequestError {
  constructor(requestOptions: ServiceClientRequestOptions, timings?: Timings) {
    super("socket timeout", requestOptions, timings);
  }
}

export class UserTimeoutError extends RequestError {
  constructor(requestOptions: ServiceClientRequestOptions, timings?: Timings) {
    super("request timeout", requestOptions, timings);
  }
}

const makeTimingPhases = (timings: Timings): TimingPhases => {
  return {
    wait: timings.socket,
    dns: subtract(timings.lookup, timings.socket),
    tcp: subtract(timings.connect, timings.lookup),
    firstByte: subtract(timings.response, timings.connect),
    download: subtract(timings.end, timings.response),
    total: timings.end
  };
};

export const request = (
  options: ServiceClientRequestOptions
): Promise<ServiceClientResponse> => {
  options = {
    protocol: "https:",
    ...options
  };

  if ("pathname" in options && !("path" in options)) {
    if ("query" in options) {
      let query = querystring.stringify(options.query);
      if (query) {
        query = "?" + query;
      }
      options.path = `${options.pathname}${query}`;
    } else {
      options.path = options.pathname;
    }
  }

  const httpRequestFn =
    options.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject: (error: RequestError) => void) => {
    let hasRequestEnded = false;
    let startTime: [number, number];
    let timings: Timings;
    if (options.timing) {
      startTime = process.hrtime();
      timings = {
        lookup: undefined,
        socket: undefined,
        connect: undefined,
        response: undefined,
        end: undefined
      };
    }

    const requestObject = httpRequestFn(
      options,
      (response: IncomingMessage) => {
        if (options.timing) {
          if (timings.lookup === undefined) {
            timings.lookup = timings.socket;
          }
          if (timings.connect === undefined) {
            timings.connect = timings.socket;
          }
          timings.response = getInterval(startTime);
        }
        let bodyStream;
        const chunks: Buffer[] = [];
        const encoding =
          response.headers && response.headers["content-encoding"];
        if (encoding === "gzip" || encoding === "deflate") {
          response.on("error", reject);
          bodyStream = response.pipe(zlib.createUnzip());
        } else {
          bodyStream = response;
        }
        bodyStream.on("error", reject);
        bodyStream.on("data", chunk => {
          if (chunk instanceof Buffer) {
            chunks.push(chunk);
          } else {
            chunks.push(Buffer.from(chunk, "utf-8"));
          }
        });
        bodyStream.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          hasRequestEnded = true;
          const serviceClientResponse = new ServiceClientResponse(
            response.statusCode || 0,
            response.headers,
            body,
            options
          );
          if (options.timing) {
            timings.end = getInterval(startTime);
            serviceClientResponse.timings = timings;
            serviceClientResponse.timingPhases = makeTimingPhases(timings);
          }
          resolve(serviceClientResponse);
        });
      }
    );
    if (options.timing) {
      requestObject.once("socket", socket => {
        timings.socket = getInterval(startTime);
        if (socket.connecting) {
          const onLookUp = () => {
            timings.lookup = getInterval(startTime);
          };
          const onConnect = () => {
            timings.connect = getInterval(startTime);
          };
          socket.once("lookup", onLookUp);
          socket.once("connect", onConnect);
          requestObject.once("error", () => {
            socket.removeListener("lookup", onLookUp);
            socket.removeListener("connect", onConnect);
          });
        } else {
          timings.lookup = timings.socket;
          timings.connect = timings.socket;
        }
      });
    }
    requestObject.on("error", error =>
      reject(new RequestError(error.message, options, timings))
    );
    requestObject.on("timeout", () => {
      requestObject.abort();
      reject(new ConnectionTimeoutError(options, timings));
    });
    if (options.dropRequestAfter) {
      setTimeout(() => {
        if (!hasRequestEnded) {
          requestObject.abort();
          reject(new UserTimeoutError(options, timings));
        }
      }, options.dropRequestAfter);
    }
    if (options.body) {
      requestObject.write(options.body);
    }
    requestObject.end();
  });
};
