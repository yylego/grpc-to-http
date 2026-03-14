import type {RpcTransport, RpcOptions, MethodInfo} from '@protobuf-ts/runtime-rpc'
import axios from 'axios'
import type {AxiosRequestConfig, AxiosResponse} from 'axios'
import type {JsonObject} from '@protobuf-ts/runtime'
import urlJoin from 'url-join';

/**
 * Configuration object for grpc-to-http.
 * Modify these options to control package runtime settings.
 */
export const grpcToHttpConfig = {
    /** Enable debug logging to console. Default: false. */
    debug: false,
}

/**
 * Custom exception class for grpc-to-http conversion failures.
 * Allows callers to distinguish conversion exceptions from network exceptions via instanceof.
 */
export class GrpcToHttpException extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'GrpcToHttpException'
    }
}

/**
 * Represents a promise that resolves to an Axios response containing the output-resp object.
 *
 * @template I - The type of the input-param object.
 * @template O - The type of the output-resp object.
 */
export type GrpcToHttpPromise<I, O> = Promise<AxiosResponse<O, AxiosRequestConfig<I>>>

/**
 * Performs a gRPC call over HTTP using the specified transport mechanism, method information, and provided options.
 * Returns a promise that resolves to the Axios response containing the output-resp object.
 *
 * @template I - The type of the input-param object.
 * @template O - The type of the output-resp object.
 * @param callType - The type of the gRPC call (e.g., unary, server streaming).
 * @param transport - The transport mechanism for the gRPC call.
 * @param method - The method information for the gRPC call.
 * @param options - The options for the gRPC call, including the base URL and metadata.
 * @param input - The input-param object containing the request data.
 * @returns A promise that resolves to the Axios response containing the output-resp object.
 * @throws Will throw an error if the HTTP method is not defined or if a required parameter is missing.
 */
export function executeGrpcToHttp<I extends object, O extends object>(
    callType: string,
    transport: RpcTransport,
    method: MethodInfo<I, O>,
    options: RpcOptions,
    input: I,
): GrpcToHttpPromise<I, O> {
    if (grpcToHttpConfig.debug) {
        console.debug(`[grpc-to-http] method=${method.name} params=${JSON.stringify(input)}`)
    }

    const baseUrl = options['baseUrl'] as string; // base URL from RpcOptions
    const apiHttp = method.options['google.api.http'] as JsonObject // HTTP mapping from proto annotations

    const reqMethods = ['get', 'post', 'put', 'delete']
    const httpMethod = Object.keys(apiHttp).find((key) => reqMethods.includes(key)) as string
    if (!httpMethod) {
        const message = Object.keys(apiHttp).length === 0
            ? 'Request error - No HTTP method defined in GRPC'
            : 'Request error - Non GET/POST/PUT/DELETE HTTP method defined in GRPC'
        throw new GrpcToHttpException(message)
    }
    let uriPath = apiHttp[httpMethod] as string

    let queryParams: I | undefined = undefined
    let requestBody: I | undefined = undefined
    if (apiHttp.body === '*') { // when body is '*', send the entire input as request body
        requestBody = input
    } else {
        if (uriPath.includes('{') && uriPath.includes('}')) {
            uriPath = rewritePathParam(uriPath, input)
        } else {
            queryParams = input
        }
    }
    const fullUrl = urlJoin(baseUrl, uriPath)
    if (grpcToHttpConfig.debug) {
        console.debug(`[grpc-to-http] method=${method.name} params=${JSON.stringify(input)} ${httpMethod.toUpperCase()} ${fullUrl}`)
    }

    const axiosConfig: AxiosRequestConfig = {
        method: httpMethod,
        url: fullUrl,
        params: queryParams, // passed as URL query string (e.g. GET requests)
        data: requestBody,
        headers: options.meta ?? {}, // pass metadata as HTTP headers
    }

    return axios.request<O, AxiosResponse<O, AxiosRequestConfig>>(axiosConfig)
}

/**
 * Rewrites the URI path by replacing path parameters with corresponding values from the input-param object.
 * If a parameter is not found in the input-param object, it attempts to convert the parameter name from snake_case to camelCase.
 *
 * @template T - The type of the input-param object.
 * @param uriPath - The URI path containing parameters in the format `{param}`.
 * @param input - The input-param object containing values for the parameters.
 * @returns The URI path with parameters replaced by their corresponding values from the input-param object.
 * @throws Will throw an error if a parameter is missing in the input-param object.
 */
function rewritePathParam<T extends object>(uriPath: string, input: T): string {
    const params = uriPath.match(/{(\w+)}/g)
    if (params) {
        params.forEach((param) => {
            const paramName = param.slice(1, -1)
            let value = (input as Record<string, unknown>)[paramName]

            if (value === undefined) {
                // try converting snake_case to camelCase (e.g. example_param_name -> exampleParamName)
                const newParamName = toCamelCase(paramName)
                value = (input as Record<string, unknown>)[newParamName]
            }

            if (value === undefined) {
                throw new GrpcToHttpException(`MISSING PARAMETER: ${paramName}`)
            }

            uriPath = uriPath.replace(param, encodeURIComponent(String(value ?? '')))
        })
    }
    return uriPath
}

/**
 * Converts a snake_case string to camelCase.
 * For example, `example_param_name` will be converted to `exampleParamName`.
 *
 * @param paramName - The snake_case string to be converted.
 * @returns The converted camelCase string.
 */
function toCamelCase(paramName: string): string {
    return paramName.replace(/_([a-z])/g, (g) => g[1]!.toUpperCase())
}
