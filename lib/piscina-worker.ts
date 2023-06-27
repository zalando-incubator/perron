import path = require("path");
import { ServiceClientRequestOptions, ServiceClientResponse, request } from "./request";

export const requestWithWorker = async({
  options
}:{  options: ServiceClientRequestOptions
}): Promise<ServiceClientResponse> => {
    console.log("START_+");
    return await request(options)
}
