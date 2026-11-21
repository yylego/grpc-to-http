import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { MessageType } from '@protobuf-ts/runtime'
import { ServiceType } from '@protobuf-ts/runtime-rpc'
import type { MethodInfo } from '@protobuf-ts/runtime-rpc'
import { AxiosError } from 'axios'
import { executeGrpcToHttp, executeGrpcToHttpStream, GrpcToHttpException } from '../src/grpc-to-http.ts'

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
])

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

before(async () => {
  server = createServer(handle)
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
