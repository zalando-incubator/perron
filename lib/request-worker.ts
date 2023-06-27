import path = require("path");
import {
  ServiceClientRequestOptions,
  ServiceClientResponse,
  request
} from "./request";
import { workerData, parentPort, Worker, isMainThread } from "worker_threads";

export const requestWithWorker = (
  options: ServiceClientRequestOptions
): Promise<ServiceClientResponse> => {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null;
    try {
      const { agent, span, ...otherOptions } = options;
      worker = new Worker(path.resolve(__dirname, "request-worker.js"), {
        workerData: {
          options: { ...otherOptions, spanCode: span?.log.toString() }
        }
      });
    } catch (e) {}
    if (worker) {
      worker.on("message", array => {
        const [statusCode, headers, body] = array;
        resolve(new ServiceClientResponse(statusCode, headers, body, options));
      });
      worker.on("error", err => {
        reject(err);
      });
      worker.on("exit", exitCode => {
        if (exitCode != 0) {
          reject(Error(`request-worker crashed`));
        }
      });
    }
  });
};

if (isMainThread) {
  exports.requestWithWorker = requestWithWorker;
} else {
  const { options } = workerData;
  options.span = {
    log: (val: any) => {
      console.log(val);
    }
  };
  request(options).then(res => {
    const { statusCode, headers, body } = res;

    try {
      parentPort?.postMessage([statusCode, headers, body]);
    } catch (e) {
      throw e;
    }
  });
}
