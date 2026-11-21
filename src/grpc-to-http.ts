import type { JsonObject, JsonReadOptions, JsonValue, JsonWriteOptions } from '@protobuf-ts/runtime'
import type { RpcTransport, RpcOptions, RpcMetadata, MethodInfo } from '@protobuf-ts/runtime-rpc'
import axios, { AxiosError, AxiosHeaders } from 'axios'
import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import urlJoin from 'url-join'

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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
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
 * Represents the async iterable of output-resp objects that a server-streaming method gives, to read with `for await`.
 *
 * @template I - The type of the input-param object, kept to match GrpcToHttpPromise.
 * @template O - The type of the output-resp object.
 */
export type GrpcToHttpStream<I, O> = AsyncGenerator<O, void, undefined>

/**
 * The WebSocket call that a client-streaming or duplex method gives: send input-param objects, read output-resp objects with `for await`.
 *
 * @template I - The type of the input-param object.
 * @template O - The type of the output-resp object.
 */
export interface GrpcToHttpWebSocket<I, O> extends AsyncIterable<O> {
  /** Sends one input-param object. The ones sent before the connection opens go out once it opens. */
  send(message: I): void
  /** Tells Kratos that no more input comes, as a gRPC CloseSend does; reading goes on. */
  closeSend(): void
  /** Closes the connection; the `for await` loop ends. */
  close(): void
}

/**
 * The options of one request: the protobuf-ts RpcOptions plus the base URL that the proto paths join onto.
 */
export interface GrpcToHttpOptions extends RpcOptions {
  /** Base URL joined in front of the proto path, such as 'http://localhost:8000'. Default: ''. */
  baseUrl?: string
  /** Reports the upload progress of one unary request (protobuf-ts names a one-response method unary), such as one that sends a big image. */
  onUploadProgress?: AxiosRequestConfig['onUploadProgress']
}

/** The HTTP verbs that a `google.api.http` rule can use. */
type HttpVerb = 'get' | 'post' | 'put' | 'patch' | 'delete'

const httpVerbs: readonly HttpVerb[] = ['get', 'post', 'put', 'patch', 'delete']

/** The `google.api.http` rule of one method: the path of its HTTP verb, and the field that makes the body. */
interface HttpRule extends Partial<Record<HttpVerb, string>> {
  body?: string
}

// Messages go out and come back in the proto3 JSON form (the protojson form that Kratos uses), as the protobuf-ts
// twirp transport does: bytes as base64, enums as names, oneof members flat, Timestamp as an RFC 3339 text.
// Default values go out too, as Kratos sends them back (EmitUnpopulated), and fields the frontend does not know yet are skipped.
// `options.jsonOptions` goes on top, as in the protobuf-ts transports, e.g. the typeRegistry that google.protobuf.Any needs.
const jsonWriteOptions: Partial<JsonWriteOptions> = { emitDefaultValues: true }
const jsonReadOptions: Partial<JsonReadOptions> = { ignoreUnknownFields: true }

/** The axios config of one request, with the fields that buildAxiosConfig always sets. */
type HttpRequestConfig = AxiosRequestConfig & {
  method: HttpVerb
  url: string
  headers: RpcMetadata
}

/**
 * Performs a gRPC call over HTTP using the specified transport mechanism, method information, and provided options.
 * Returns a promise that resolves to the Axios response containing the output-resp object.
 *
 * @template I - The type of the input-param object.
 * @template O - The type of the output-resp object.
 * @param _callType - The kind of gRPC method; kept so that generated clients pass the same arguments, unused.
 * @param _transport - The protobuf-ts transport; kept so that generated clients pass the same arguments, unused.
 * @param method - The method information for the gRPC call.
 * @param options - The options for the gRPC call, including the base URL and metadata.
 * @param input - The input-param object containing the request data.
 * @returns A promise that resolves to the Axios response containing the output-resp object.
 * @throws The promise rejects with a GrpcToHttpException when the HTTP rule, a path param, the JSON form is wrong,
 * and with an AxiosError when the request fails.
 */
export async function executeGrpcToHttp<I extends object, O extends object>(_callType: string, _transport: RpcTransport, method: MethodInfo<I, O>, options: RpcOptions, input: I): GrpcToHttpPromise<I, O> {
  // async, so a conversion exception rejects the promise as a network exception does, and .catch() sees both
  const axiosConfig = buildAxiosConfig(method, options, input)
  const { onUploadProgress } = options as GrpcToHttpOptions
  if (onUploadProgress) {
    axiosConfig.onUploadProgress = onUploadProgress
  }
  const response = await axios.request<JsonValue, AxiosResponse<JsonValue, AxiosRequestConfig>>(axiosConfig)
  return { ...response, data: readMessage(method, options, response.data) }
}

/**
 * Performs a server-streaming gRPC method through HTTP, reading the Server-Sent Events that Kratos v3 sends.
 * Each `event: message` gives one output-resp object; the iteration ends when Kratos closes the connection.
 * The method, path, query and body follow the same `google.api.http` rules as executeGrpcToHttp, and `options.meta` goes out as headers.
 * Pass `options.abort` (an AbortSignal) to stop reading, such as when the page closes; `options.timeout` has no effect on a stream.
 *
 * A Kratos fault (an HTTP status, `event: error`) throws an AxiosError whose `response.data` is the Kratos error object
 * (code, reason, message, metadata), the same shape as a unary method throws, so one catch block handles both.
 * An abort, a network fault throws the fetch exception as-is (an AbortError DOMException, a TypeError).
 *
 * @template I - The type of the input-param object.
 * @template O - The type of the output-resp object.
 * @param method - The method information of the gRPC method.
 * @param options - The options of the request, including the base URL, metadata and `abort`.
 * @param input - The input-param object containing the request data.
 * @returns An async iterable of the output-resp objects, to read with `for await`.
 */
export async function* executeGrpcToHttpStream<I extends object, O extends object>(method: MethodInfo<I, O>, options: RpcOptions, input: I): GrpcToHttpStream<I, O> {
  const axiosConfig = buildAxiosConfig(method, options, input)
  // Kratos has no codec named event-stream, so it takes the JSON codec from the next item,
  // the same codec that unary methods get
  const headers = new Headers({ Accept: 'text/event-stream, application/json' })
  for (const [name, value] of Object.entries(axiosConfig.headers)) {
    for (const item of [value].flat()) {
      headers.append(name, item)
    }
  }
  const init: RequestInit = { method: axiosConfig.method.toUpperCase(), headers }
  if (axiosConfig.data !== undefined) {
    init.body = axiosConfig.data
  }
  if (options.abort) {
    init.signal = options.abort
  }
  const fullURL = axios.getUri(axiosConfig)

  const response = await fetch(fullURL, init)
  if (!response.ok) {
    // the stream did not start, so the body holds a plain Kratos error object
    throw newKratosFault(axiosConfig, response.status, await readResponseJson(response), Object.fromEntries(response.headers))
  }
  if (!response.body) {
    throw new GrpcToHttpException(`${method.name}: the stream response has no content`)
  }

  for await (const sseEvent of readServerSentEvents(response.body)) {
    if (sseEvent.event === 'error') {
      const data = JSON.parse(sseEvent.data) as { code?: number }
      throw newKratosFault(axiosConfig, data.code ?? 500, data, {})
    }
    if (sseEvent.event === 'message') {
      // Kratos sends just the events `message` and `error`; the rest are not output-resp objects
      yield readMessage(method, options, JSON.parse(sseEvent.data))
    }
  }
}

// The text frames that Kratos v3 adds to a WebSocket stream besides the messages: the end of the input, and an error before it closes.
const websocketControlEnd = '\x1eend'
const websocketControlError = '\x1eerror:'

/**
 * Performs a client-streaming or duplex gRPC method through the WebSocket that Kratos v3 serves it on.
 * The URL is the path of the `google.api.http` rule joined onto `options.baseUrl`, with http turned into ws and https into wss.
 * Kratos binds path params of that URL into each message, but the generated method takes no input up front to fill them,
 * so the route of a WebSocket method has no path params and the values go in the messages.
 * Each message goes both ways as one proto3 JSON text frame; with `body: "<field>"` naming one singular message field,
 * each frame sent is just that field, as Kratos reads it, and with any other body the frame is the whole input.
 * A body field of type google.api.HttpBody (raw bytes frames) is not handled.
 *
 * Browsers cannot set headers on a WebSocket, so `options.meta` does not go out; cookies of the same site do.
 * Pass `options.abort` (an AbortSignal) to close the connection, such as when the page closes; `options.timeout` has no effect.
 *
 * The `for await` loop ends when Kratos closes the connection as normal, or when `close()` is called.
 * A Kratos fault (the `\x1eerror:` frame) throws an AxiosError whose `response.data` holds the code, reason and message
 * that Kratos wrote in the frame, the same shape as a unary method throws. A connection that closes in a fault throws an Error naming the close code.
 *
 * @template I - The type of the input-param object.
 * @template O - The type of the output-resp object.
 * @param method - The method information of the gRPC method.
 * @param options - The options of the request, including the base URL and `abort`.
 * @returns The call: `send` and `closeSend` to write, `for await` to read, `close` to stop.
 * @throws GrpcToHttpException when the HTTP rule is wrong or its path has path params.
 */
export function executeGrpcToHttpWebSocket<I extends object, O extends object>(method: MethodInfo<I, O>, options: RpcOptions): GrpcToHttpWebSocket<I, O> {
  const rule = (method.options['google.api.http'] ?? {}) as HttpRule
  const httpMethod = httpVerbs.find((verb) => rule[verb] !== undefined)
  if (!httpMethod) {
    throw new GrpcToHttpException(`${method.name}: the method has no google.api.http rule`)
  }
  const { uriPath } = rewritePathParam(method, rule[httpMethod] ?? '', {})
  const joinedURL = urlJoin((options as GrpcToHttpOptions).baseUrl ?? '', uriPath)
  // a relative URL resolves against the page; with no page (SSR, Node) it needs an absolute baseUrl
  if (!URL.canParse(joinedURL, globalThis.location?.href)) {
    throw new GrpcToHttpException(`${method.name}: the WebSocket URL ${joinedURL} is relative and there is no page to resolve it, set an absolute baseUrl`)
  }
  const fullURL = new URL(joinedURL, globalThis.location?.href)
  fullURL.protocol = fullURL.protocol === 'https:' ? 'wss:' : 'ws:'
  if (grpcToHttpConfig.debug) {
    const metaNames = Object.keys(options.meta ?? {})
    console.debug(`[grpc-to-http] method=${method.name} WebSocket ${fullURL.href}${metaNames.length > 0 ? ` (a WebSocket cannot carry the meta headers ${metaNames.join(', ')})` : ''}`)
  }
  // as Kratos reads each frame: just the body field when it names one singular message field (WithStreamBodyField,
  // which protoc-gen-go-http adds when BodyMessage holds), else the whole input, a scalar, repeated or map body field too
  const bodyField = rule.body && rule.body !== '*' ? method.I.fields.find((field) => field.name === rule.body) : undefined
  const bodyName = bodyField?.kind === 'message' && !bodyField.repeat ? bodyField.jsonName : undefined
  const config: HttpRequestConfig = { method: 'get', url: fullURL.href, headers: {} }

  const socket = new WebSocket(fullURL)
  socket.binaryType = 'arraybuffer'
  const unsent: string[] = [] // frames written before the connection opens
  const received: O[] = []
  let sendClosed = false
  let finished: { fault?: unknown } | undefined = undefined
  let wake: (() => void) | undefined = undefined

  const finish = (fault?: unknown) => {
    if (finished) return
    finished = fault === undefined ? {} : { fault }
    options.abort?.removeEventListener('abort', close)
    wake?.()
  }
  const write = (text: string) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(text)
    else unsent.push(text)
  }
  function close() {
    sendClosed = true
    finish()
    socket.close(1000)
  }

  socket.onopen = () => {
    for (const text of unsent.splice(0)) socket.send(text)
  }
  socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
    const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
    if (text === websocketControlEnd) {
      finish()
    } else if (text.startsWith(websocketControlError)) {
      const data = readKratosErrorText(text.slice(websocketControlError.length))
      finish(newKratosFault(config, data.code, data, {}))
    } else {
      try {
        received.push(readMessage(method, options, JSON.parse(text)))
        wake?.()
      } catch (cause) {
        finish(cause instanceof GrpcToHttpException ? cause : new GrpcToHttpException(`${method.name}: the response is not ${method.O.typeName} JSON`, { cause }))
        socket.close(1000)
      }
    }
  }
  socket.onclose = (event: CloseEvent) => {
    // Kratos ends a stream with 1000; the rest (1001 when the server shuts down, 1006 when the network drops) cut it off
    finish(event.code === 1000 ? undefined : new Error(`${method.name}: the WebSocket closed with code ${event.code} ${event.reason}`.trim()))
  }
  if (options.abort?.aborted) {
    close()
  } else {
    options.abort?.addEventListener('abort', close, { once: true })
  }

  async function* read(): AsyncGenerator<O, void, undefined> {
    try {
      for (;;) {
        const next = received.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (finished) {
          if (finished.fault !== undefined) throw finished.fault
          return
        }
        await new Promise<void>((resolve) => (wake = resolve))
        wake = undefined
      }
    } finally {
      // also closes the connection when the loop stops ahead of time (a break, an exception), as the server-streaming read does
      close()
    }
  }

  return {
    send(message: I) {
      // also after the connection ended (Kratos closed it, a fault), so a message never waits in a queue that cannot go out
      if (sendClosed || finished) {
        throw new GrpcToHttpException(`${method.name}: the WebSocket send side is closed`)
      }
      let json: JsonObject
      try {
        json = method.I.toJson(message, { ...jsonWriteOptions, ...options.jsonOptions }) as JsonObject
      } catch (cause) {
        throw new GrpcToHttpException(`${method.name}: cannot write ${method.I.typeName} as JSON`, { cause })
      }
      // an unset body field goes as a blank message, which Kratos reads as one
      write(JSON.stringify(bodyName === undefined ? json : (json[bodyName] ?? {})))
    },
    closeSend() {
      if (sendClosed) return
      sendClosed = true
      write(websocketControlEnd)
    },
    close,
    [Symbol.asyncIterator]: read,
  }
}

/**
 * Reads the error text that Kratos writes in the `\x1eerror:` frame, the text of its Error():
 * `error: code = 404 reason = NOT_FOUND message = gone metadata = map[] cause = <nil>`.
 * Kratos writes text here (its SSE errors are JSON), so the text is the one source of the code, reason and message.
 * The message stops at the first ` metadata = map[`, since the cause is often another Kratos error that has one too.
 * A text in another form (a Go error that is not a Kratos error) counts as code 500 with no reason, as Kratos FromError reads it.
 */
function readKratosErrorText(text: string): { code: number; reason: string; message: string } {
  const matched = /^error: code = (\d+) reason = (\S*) message = (.*?) metadata = map\[.*\] cause = .*$/s.exec(text)
  if (!matched) {
    return { code: 500, reason: '', message: text }
  }
  return { code: Number(matched[1]), reason: matched[2] ?? '', message: matched[3] ?? '' }
}

/**
 * Builds the axios config of one request from the `google.api.http` rule of the method: the HTTP method, the URL with path params,
 * the query params, the body, and `options.meta` as headers.
 */
function buildAxiosConfig<I extends object, O extends object>(method: MethodInfo<I, O>, options: RpcOptions, input: I): HttpRequestConfig {
  const baseUrl = (options as GrpcToHttpOptions).baseUrl ?? ''
  // the protobuf-ts runtime keeps proto options as plain JSON, so this is the one place that names its shape
  const rule = (method.options['google.api.http'] ?? {}) as HttpRule

  const httpMethod = httpVerbs.find((verb) => rule[verb] !== undefined)
  if (!httpMethod) {
    const reason = Object.keys(rule).length === 0 ? 'the method has no google.api.http rule' : 'the google.api.http rule uses a custom verb, not get/post/put/patch/delete'
    throw new GrpcToHttpException(`${method.name}: ${reason}`)
  }
  // the JSON form of the input, with the field names as protojson writes them (the jsonName of each field)
  let message: JsonObject
  try {
    message = method.I.toJson(input, { ...jsonWriteOptions, ...options.jsonOptions }) as JsonObject
  } catch (cause) {
    throw new GrpcToHttpException(`${method.name}: cannot write ${method.I.typeName} as JSON`, { cause })
  }
  // path params go into the path; as google.api.http says, the fields left go into the body, else into the query
  const { uriPath, pathNames } = rewritePathParam(method, rule[httpMethod] ?? '', message)
  const restFields = Object.fromEntries(Object.entries(message).filter(([name]) => !pathNames.includes(name)))

  let searchParams: JsonObject | undefined = undefined
  let payload: JsonValue | undefined = undefined
  const bodyField = rule.body
  if (bodyField === '*') {
    // the whole input goes as the body
    payload = message
  } else if (bodyField) {
    // one field goes as the body, the rest go as the query
    const bodyName = findJsonName(method, bodyField)
    payload = message[bodyName]
    searchParams = Object.fromEntries(Object.entries(restFields).filter(([name]) => name !== bodyName))
  } else {
    // no body, the fields go as the query
    searchParams = restFields
  }
  // the same JSON text in both kinds of methods; a body field left unset (null) sends no content, which Kratos reads as a blank message
  const data = payload === undefined || payload === null ? undefined : JSON.stringify(payload)
  const headers: RpcMetadata = { ...options.meta } // pass metadata as HTTP headers
  if (bodyField) {
    // Kratos picks the body codec from Content-Type and rejects a request that has none, even one with no content
    headers['Content-Type'] = 'application/json'
  }
  // Use url-join as-is, do not hand-write path normalization: from 5.2 it keeps the slashes it is given,
  // so callers set baseUrl to suit the proto paths. With paths like '/api/x', baseUrl '' gives '/api/x',
  // while baseUrl '/' gives '//api/x', which browsers treat as host 'api' (protocol-relative URL).
  const fullURL = urlJoin(baseUrl, uriPath)
  if (grpcToHttpConfig.debug) {
    console.debug(`[grpc-to-http] method=${method.name} params=${JSON.stringify(message)} ${httpMethod.toUpperCase()} ${fullURL}`)
  }

  const axiosConfig: HttpRequestConfig = {
    method: httpMethod,
    url: fullURL,
    params: searchParams, // passed as URL query string (e.g. GET requests)
    // the form Kratos decodes: repeated fields as tags=a&tags=b, nested fields as page.size=1
    paramsSerializer: { dots: true, indexes: null },
    data,
    headers,
  }
  if (options.abort) {
    // stop the request, such as when the page closes
    axiosConfig.signal = options.abort
  }
  const { timeout } = options
  if (timeout !== undefined) {
    // milliseconds, else a Date deadline, as protobuf-ts defines it; a past deadline sets 1ms
    axiosConfig.timeout = timeout instanceof Date ? Math.max(timeout.getTime() - Date.now(), 1) : timeout
  }
  return axiosConfig
}

/**
 * Reads one output-resp object from its JSON form. Content that is not that JSON, such as an HTML login page,
 * throws a GrpcToHttpException that names the method.
 */
function readMessage<I extends object, O extends object>(method: MethodInfo<I, O>, options: RpcOptions, data: unknown): O {
  try {
    return method.O.fromJson(data as JsonValue, { ...jsonReadOptions, ...options.jsonOptions })
  } catch (cause) {
    throw new GrpcToHttpException(`${method.name}: the response is not ${method.O.typeName} JSON`, { cause })
  }
}

/**
 * Finds the JSON name of a field from its proto name, as protojson writes it (lowerCamelCase, else the json_name option).
 */
function findJsonName<I extends object, O extends object>(method: MethodInfo<I, O>, protoName: string): string {
  return method.I.fields.find((field) => field.name === protoName)?.jsonName ?? protoName
}

/**
 * One Server-Sent Event: the event name and the data lines joined with "\n".
 */
interface ServerSentEvent {
  event: string
  data: string
}

/**
 * Reads Server-Sent Events from a response body: lines of `event:` and `data:` up to a blank line make one event.
 * An event with no `event:` line counts as `message`, as the SSE standard says.
 */
async function* readServerSentEvents(content: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent, void, undefined> {
  const stream = content.getReader()
  const utf8 = new TextDecoder()
  let pending = '' // text received but not yet split into lines
  let event = ''
  let dataLines: string[] = []
  try {
    for (;;) {
      const { value, done } = await stream.read()
      if (done) {
        return
      }
      pending += utf8.decode(value, { stream: true }) // stream mode keeps a UTF-8 code point split across two chunks whole
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (line === '') {
          if (dataLines.length > 0) {
            // the SSE standard sends no event that has no data
            yield { event: event || 'message', data: dataLines.join('\n') }
          }
          event = ''
          dataLines = []
        } else if (line.startsWith('event:')) {
          event = line.slice('event:'.length).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
        }
        newline = pending.indexOf('\n')
      }
    }
  } finally {
    // also closes the connection when the loop stops ahead of time (a break, an exception), so Kratos stops sending
    await stream.cancel()
  }
}

/**
 * Builds the AxiosError that a unary method throws on the same Kratos fault, so one catch block handles both kinds of methods.
 */
function newKratosFault(config: HttpRequestConfig, status: number, data: unknown, headers: Record<string, string>): AxiosError {
  const response: AxiosResponse = {
    data,
    status,
    statusText: '',
    headers,
    config: { ...config, headers: new AxiosHeaders(config.headers) },
  }
  // the same code that axios gives: 4xx is a bad request, 5xx a bad response
  const code = status < 500 ? AxiosError.ERR_BAD_REQUEST : AxiosError.ERR_BAD_RESPONSE
  return new AxiosError(`Request failed with status code ${status}`, code, response.config, undefined, response)
}

/**
 * Reads the content of a response as JSON, and gives the text when it is not JSON.
 */
async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Rewrites the URI path, replacing each path param with the matching value from the JSON form of the input-param object.
 * The path uses the proto name of each field and the JSON form uses its JSON name, so each name is looked up in the method fields.
 *
 * @param method - The method information, to name it in the exception message and to look up its input fields.
 * @param uriPath - The URI path containing path params in the format `{param}`.
 * @param message - The JSON form of the input-param object, holding the values of the path params.
 * @returns The URI path with each path param replaced with its value, and the JSON names of the fields that went into the path.
 * @throws GrpcToHttpException when a path param is missing in the message.
 */
function rewritePathParam<I extends object, O extends object>(method: MethodInfo<I, O>, uriPath: string, message: JsonObject): { uriPath: string; pathNames: string[] } {
  const pathNames: string[] = []
  for (const param of uriPath.match(/{(\w+)}/g) ?? []) {
    const paramName = param.slice(1, -1)
    const jsonName = findJsonName(method, paramName)
    const value = message[jsonName]
    // an unset string comes as '', and a blank segment would reach a different route
    if (value === undefined || value === null || value === '') {
      throw new GrpcToHttpException(`${method.name}: path param ${paramName} is missing`)
    }
    uriPath = uriPath.replace(param, encodeURIComponent(String(value)))
    pathNames.push(jsonName)
  }
  // a path param in a different form ({a.b}, {name=x/*}) would go out as-is and reach the wrong URL
  if (uriPath.includes('{')) {
    throw new GrpcToHttpException(`${method.name}: path param form not supported in ${uriPath}`)
  }
  return { uriPath, pathNames }
}
