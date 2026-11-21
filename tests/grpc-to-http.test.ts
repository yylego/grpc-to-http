import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { MessageType } from '@protobuf-ts/runtime'
import { ServiceType } from '@protobuf-ts/runtime-rpc'
import type { MethodInfo } from '@protobuf-ts/runtime-rpc'
import { AxiosError } from 'axios'
import { WebSocketServer } from 'ws'
import { executeGrpcToHttp, executeGrpcToHttpStream, executeGrpcToHttpWebSocket, GrpcToHttpException } from '../src/grpc-to-http.ts'

interface ArticleParam {
  articleId: string
  tags: string[]
  title: string
}

interface ArticleResp {
  articleId: string
  title: string
}

const ArticleParam = new MessageType<ArticleParam>('demo.ArticleParam', [
  { no: 1, name: 'article_id', kind: 'scalar', T: 9 },
  { no: 2, name: 'tags', kind: 'scalar', T: 9, repeat: 2 },
  { no: 3, name: 'title', kind: 'scalar', T: 9 },
])

const ArticleResp = new MessageType<ArticleResp>('demo.ArticleResp', [
  { no: 1, name: 'article_id', kind: 'scalar', T: 9 },
  { no: 2, name: 'title', kind: 'scalar', T: 9 },
])

const ArticleService = new ServiceType('demo.ArticleService', [
  { name: 'GetArticle', I: ArticleParam, O: ArticleResp, options: { 'google.api.http': { get: '/v1/articles/{article_id}' } } },
  { name: 'UpdateArticle', I: ArticleParam, O: ArticleResp, options: { 'google.api.http': { put: '/v1/articles/{article_id}', body: '*' } } },
  { name: 'WatchArticle', I: ArticleParam, O: ArticleResp, serverStreaming: true, options: { 'google.api.http': { get: '/v1/articles/{article_id}/watch' } } },
  { name: 'PlainArticle', I: ArticleParam, O: ArticleResp, options: {} },
  { name: 'ChatArticle', I: ArticleParam, O: ArticleResp, clientStreaming: true, serverStreaming: true, options: { 'google.api.http': { get: '/v1/articles/chat' } } },
  { name: 'FailArticle', I: ArticleParam, O: ArticleResp, clientStreaming: true, serverStreaming: true, options: { 'google.api.http': { get: '/v1/articles/fail' } } },
  { name: 'KeyedChat', I: ArticleParam, O: ArticleResp, clientStreaming: true, serverStreaming: true, options: { 'google.api.http': { get: '/v1/articles/{article_id}/chat' } } },
  { name: 'GoneArticle', I: ArticleParam, O: ArticleResp, clientStreaming: true, serverStreaming: true, options: { 'google.api.http': { get: '/v1/articles/gone' } } },
  { name: 'CauseArticle', I: ArticleParam, O: ArticleResp, clientStreaming: true, serverStreaming: true, options: { 'google.api.http': { get: '/v1/articles/cause' } } },
])

interface DraftParam {
  room: string
  draft?: ArticleResp
}

const DraftParam = new MessageType<DraftParam>('demo.DraftParam', [
  { no: 1, name: 'room', kind: 'scalar', T: 9 },
  { no: 2, name: 'draft', kind: 'message', T: () => ArticleResp },
])

/** A WebSocket method whose rule names a body field: each frame is just that field, as Kratos WithStreamBodyField reads it. */
const DraftService = new ServiceType('demo.DraftService', [
  { name: 'SendDrafts', I: DraftParam, O: ArticleResp, clientStreaming: true, serverStreaming: true, options: { 'google.api.http': { get: '/v1/articles/chat', body: 'draft' } } },
  { name: 'SendRooms', I: DraftParam, O: ArticleResp, clientStreaming: true, serverStreaming: true, options: { 'google.api.http': { get: '/v1/articles/chat', body: 'room' } } },
])
const sendDrafts = DraftService.methods[0] as MethodInfo<DraftParam, ArticleResp>
/** Its body field is a scalar, which Kratos does not stream frame by frame (no BodyMessage), so each frame is the whole input. */
const sendRooms = DraftService.methods[1] as MethodInfo<DraftParam, ArticleResp>

function findMethod(name: string): MethodInfo<ArticleParam, ArticleResp> {
  return ArticleService.methods.find((m) => m.name === name) as MethodInfo<ArticleParam, ArticleResp>
}

interface SeenRequest {
  method: string
  url: string
  contentType: string | undefined
  token: string | undefined
  content: string
}

const seen: SeenRequest[] = []
let server: Server
let baseUrl = ''

function handle(req: IncomingMessage, res: ServerResponse): void {
  let content = ''
  req.on('data', (chunk: Buffer) => (content += chunk.toString()))
  req.on('end', () => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', contentType: req.headers['content-type'], token: req.headers['authorization'] as string | undefined, content })
    const path = new URL(req.url ?? '', 'http://127.0.0.1').pathname
    if (path === '/v1/articles/bad-json') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>login</html>')
    } else if (path === '/v1/articles/fail/watch') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('event: message\ndata: {"articleId":"fail","title":"one"}\n\nevent: error\ndata: {"code":404,"reason":"ARTICLE_NOT_FOUND","message":"gone"}\n\n')
    } else if (path === '/v1/articles/7/watch') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: message\ndata: {"articleId":"7","title":"one"}\n\n')
      res.end('data: {"articleId":"7","title":"two"}\n\n')
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"articleId":"7","title":"done","unknownField":1}')
    }
  })
}

/** The text frames the WebSocket server got, in order, as Kratos would read them. */
const frames: string[] = []

/**
 * Serves the WebSocket methods as Kratos v3 does: one proto3 JSON text frame per message,
 * `\x1eend` for the end of the input, `\x1eerror:` and close code 1011 for a fault.
 */
function serveWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (socket, req) => {
    if (req.url === '/v1/articles/fail') {
      socket.send('\x1eerror:error: code = 404 reason = ARTICLE_NOT_FOUND message = gone metadata = map[] cause = <nil>')
      socket.close(1011, 'gone')
      return
    }
    if (req.url === '/v1/articles/cause') {
      // the cause is another Kratos error, whose text has its own " metadata = map["
      socket.send('\x1eerror:error: code = 503 reason = STORE_DOWN message = cannot save metadata = map[] cause = error: code = 500 reason = DB message = timeout metadata = map[] cause = <nil>')
      socket.close(1011, 'down')
      return
    }
    if (req.url === '/v1/articles/gone') {
      // what a Kratos server that shuts down sends
      socket.close(1001, 'going away')
      return
    }
    socket.on('message', (data) => {
      const text = data.toString()
      frames.push(text)
      if (text === '\x1eend') {
        socket.close(1000)
        return
      }
      const input = JSON.parse(text) as { articleId: string; title: string }
      socket.send(JSON.stringify({ articleId: input.articleId, title: `re:${input.title}`, unknownField: 1 }))
    })
  })
}

before(async () => {
  server = createServer(handle)
  serveWebSocket(new WebSocketServer({ server }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
  server.close()
})

test('GET puts the path param into the path and the rest into the query', async () => {
  seen.length = 0
  const input = { articleId: '7', tags: ['a', 'b'], title: '' }
  const response = await executeGrpcToHttp('unary', undefined as never, findMethod('GetArticle'), { baseUrl, meta: { Authorization: 'token-1' } } as never, input)
  assert.deepEqual(response.data, { articleId: '7', title: 'done' })
  assert.deepEqual(seen, [{ method: 'GET', url: '/v1/articles/7?tags=a&tags=b&title=', contentType: undefined, token: 'token-1', content: '' }])
})

test('PUT with body "*" sends the whole input as JSON', async () => {
  seen.length = 0
  const input = { articleId: '7', tags: [], title: 'new' }
  await executeGrpcToHttp('unary', undefined as never, findMethod('UpdateArticle'), { baseUrl } as never, input)
  assert.deepEqual(seen, [{ method: 'PUT', url: '/v1/articles/7', contentType: 'application/json', token: undefined, content: '{"articleId":"7","tags":[],"title":"new"}' }])
})

test('a blank path param rejects before any request goes out', async () => {
  seen.length = 0
  const input = { articleId: '', tags: [], title: '' }
  await assert.rejects(executeGrpcToHttp('unary', undefined as never, findMethod('GetArticle'), { baseUrl } as never, input), GrpcToHttpException)
  assert.equal(seen.length, 0)
})

test('a method with no google.api.http rule rejects', async () => {
  const input = { articleId: '7', tags: [], title: '' }
  await assert.rejects(executeGrpcToHttp('unary', undefined as never, findMethod('PlainArticle'), { baseUrl } as never, input), GrpcToHttpException)
})

test('a response that is not the message JSON rejects', async () => {
  const input = { articleId: 'bad-json', tags: [], title: '' }
  await assert.rejects(executeGrpcToHttp('unary', undefined as never, findMethod('GetArticle'), { baseUrl } as never, input), GrpcToHttpException)
})

test('a stream gives each message event, with or without the event line', async () => {
  const titles: string[] = []
  for await (const resp of executeGrpcToHttpStream(findMethod('WatchArticle'), { baseUrl } as never, { articleId: '7', tags: [], title: '' })) {
    titles.push(resp.title)
  }
  assert.deepEqual(titles, ['one', 'two'])
})

test('a stream error event throws the AxiosError that carries the Kratos error object', async () => {
  const titles: string[] = []
  await assert.rejects(
    async () => {
      for await (const resp of executeGrpcToHttpStream(findMethod('WatchArticle'), { baseUrl } as never, { articleId: 'fail', tags: [], title: '' })) {
        titles.push(resp.title)
      }
    },
    (caught: unknown) => {
      assert.ok(caught instanceof AxiosError)
      assert.equal(caught.response?.status, 404)
      assert.deepEqual(caught.response?.data, { code: 404, reason: 'ARTICLE_NOT_FOUND', message: 'gone' })
      return true
    },
  )
  assert.deepEqual(titles, ['one'])
})

test('a WebSocket sends the messages written before it opens, then reads each reply until Kratos closes', async () => {
  frames.length = 0
  const call = executeGrpcToHttpWebSocket(findMethod('ChatArticle'), { baseUrl } as never)
  call.send({ articleId: '7', tags: [], title: 'one' })
  call.send({ articleId: '7', tags: [], title: 'two' })
  call.closeSend()
  const titles: string[] = []
  for await (const resp of call) {
    titles.push(resp.title)
  }
  assert.deepEqual(titles, ['re:one', 're:two'])
  assert.deepEqual(frames, ['{"articleId":"7","tags":[],"title":"one"}', '{"articleId":"7","tags":[],"title":"two"}', '\x1eend'])
  assert.throws(() => call.send({ articleId: '7', tags: [], title: 'late' }), GrpcToHttpException)
})

test('a WebSocket error frame throws the AxiosError that carries the Kratos code, reason and message', async () => {
  const call = executeGrpcToHttpWebSocket(findMethod('FailArticle'), { baseUrl } as never)
  await assert.rejects(
    async () => {
      for await (const _ of call) {
        assert.fail('no message comes before the error')
      }
    },
    (caught: unknown) => {
      assert.ok(caught instanceof AxiosError)
      assert.equal(caught.response?.status, 404)
      assert.deepEqual(caught.response?.data, { code: 404, reason: 'ARTICLE_NOT_FOUND', message: 'gone' })
      return true
    },
  )
})

test('a WebSocket loop that stops ahead of time closes the connection', async () => {
  const call = executeGrpcToHttpWebSocket(findMethod('ChatArticle'), { baseUrl } as never)
  call.send({ articleId: '8', tags: [], title: 'one' })
  for await (const resp of call) {
    assert.equal(resp.title, 're:one')
    break
  }
  assert.throws(() => call.send({ articleId: '8', tags: [], title: 'two' }), GrpcToHttpException)
})

test('a WebSocket path with a path param throws before connecting', () => {
  assert.throws(() => executeGrpcToHttpWebSocket(findMethod('KeyedChat'), { baseUrl } as never), GrpcToHttpException)
})

test('a WebSocket send after Kratos closed the connection throws instead of waiting in the queue', async () => {
  const call = executeGrpcToHttpWebSocket(findMethod('FailArticle'), { baseUrl } as never)
  await assert.rejects(async () => {
    for await (const _ of call) {
      assert.fail('no message comes before the error')
    }
  }, AxiosError)
  assert.throws(() => call.send({ articleId: '9', tags: [], title: 'late' }), GrpcToHttpException)
})

test('a WebSocket with an abort signal aborted up front ends at once', async () => {
  const stop = new AbortController()
  stop.abort()
  const titles: string[] = []
  for await (const resp of executeGrpcToHttpWebSocket(findMethod('ChatArticle'), { baseUrl, abort: stop.signal } as never)) {
    titles.push(resp.title)
  }
  assert.deepEqual(titles, [])
})

test('a WebSocket method with body: "<field>" sends just that field in each frame', async () => {
  frames.length = 0
  const call = executeGrpcToHttpWebSocket(sendDrafts, { baseUrl } as never)
  call.send({ room: 'r1', draft: { articleId: '7', title: 'one' } })
  call.closeSend()
  const titles: string[] = []
  for await (const resp of call) {
    titles.push(resp.title)
  }
  assert.deepEqual(titles, ['re:one'])
  assert.deepEqual(frames, ['{"articleId":"7","title":"one"}', '\x1eend'])
})

test('a WebSocket method whose body field is a scalar sends the whole input in each frame', async () => {
  frames.length = 0
  const call = executeGrpcToHttpWebSocket(sendRooms, { baseUrl } as never)
  call.send({ room: 'r1', draft: { articleId: '7', title: 'one' } })
  call.closeSend()
  for await (const _ of call) {
    // the reply is not what this test checks
  }
  assert.deepEqual(frames, ['{"room":"r1","draft":{"articleId":"7","title":"one"}}', '\x1eend'])
})

test('a WebSocket error frame whose cause is another Kratos error keeps the outer message', async () => {
  const call = executeGrpcToHttpWebSocket(findMethod('CauseArticle'), { baseUrl } as never)
  await assert.rejects(
    async () => {
      for await (const _ of call) {
        assert.fail('no message comes before the error')
      }
    },
    (caught: unknown) => {
      assert.ok(caught instanceof AxiosError)
      assert.deepEqual(caught.response?.data, { code: 503, reason: 'STORE_DOWN', message: 'cannot save' })
      return true
    },
  )
})

test('a WebSocket that the server closes with 1001 (shutting down) throws, so the caller can reconnect', async () => {
  const call = executeGrpcToHttpWebSocket(findMethod('GoneArticle'), { baseUrl } as never)
  await assert.rejects(
    async () => {
      for await (const _ of call) {
        assert.fail('no message comes before the close')
      }
    },
    (caught: unknown) => {
      assert.ok(caught instanceof Error && !(caught instanceof AxiosError))
      assert.match(caught.message, /^GoneArticle: the WebSocket closed with code 1001/)
      return true
    },
  )
})

test('a WebSocket with a relative baseUrl and no page throws a clear exception', () => {
  assert.throws(() => executeGrpcToHttpWebSocket(findMethod('ChatArticle'), { baseUrl: '' } as never), GrpcToHttpException)
})
