import path = require("path");
import { ServiceClientRequestOptions, ServiceClientResponse, request } from "./request";

const requestWithWorker = async({
  options
}:{  options: any
}): Promise<ServiceClientResponse> => {
    console.log("START_+");
    options.span = {log : new Function(`return ${options.spanCode}`)}
    return await request(options)
}

export default requestWithWorker;
