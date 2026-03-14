# grpc-to-http

将 TypeScript gRPC 客户端转换为基于 Axios 的 HTTP 客户端。

---

## 英文文档

[ENGLISH README](README.md)

## 功能特性

- 将 protobuf-ts 生成的 gRPC 客户端调用转换为 HTTP/REST 请求
- 使用 Axios 作为 HTTP 传输层
- 自动提取和重写路径参数
- 通过 `google.api.http` 注解支持 GET/POST/PUT/DELETE 方法
- 自动将 snake_case 参数名转换为 camelCase
- 轻量级，依赖极少

## 工作原理

使用 [protobuf-ts](https://github.com/timostamm/protobuf-ts) 生成 TypeScript gRPC 客户端时，生成的代码使用 `stackIntercept` 和 `UnaryCall` 进行 gRPC 传输。本包提供 `executeGrpcToHttp` 和 `GrpcToHttpPromise` 作为替代，通过 Axios 将请求转发到 HTTP/REST 端点。

转换过程读取 `.proto` 文件中的 `google.api.http` 注解来确定：
- HTTP 方法（GET/POST/PUT/DELETE）
- URL 路径（含参数替换）
- 请求体处理方式

当后端（如 [Kratos](https://github.com/go-kratos/kratos)）同时暴露 gRPC 和 HTTP 端点时，前端可以直接使用 HTTP 调用，无需配置 gRPC 代理。

## 关联项目

- [kratos-vue3](https://github.com/yylego/kratos-vue3) — Go 包，将 Vue3 前端与 Kratos 后端集成，使用本包桥接 gRPC 和 HTTP
- [kratos-vue3-demo](https://github.com/kratos-examples/vue3) — 完整的演示项目，展示如何配合 Kratos 和 Vue3 使用 grpc-to-http

## 安装

```bash
npm install @yylego/grpc-to-http
```

## 使用

在 protobuf-ts 生成的客户端文件中导入核心函数：

```typescript
import { executeGrpcToHttp } from '@yylego/grpc-to-http/src/grpc-to-http';
import type { GrpcToHttpPromise } from '@yylego/grpc-to-http/src/grpc-to-http';
```

### API

**`executeGrpcToHttp<I, O>(callType, transport, method, options, input)`**

通过 HTTP 执行 gRPC 调用。参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `callType` | `string` | gRPC 调用类型（如 "unary"） |
| `transport` | `RpcTransport` | protobuf-ts 传输机制 |
| `method` | `MethodInfo<I, O>` | protobuf-ts 方法信息 |
| `options` | `RpcOptions` | 选项，包含 `baseUrl` 和 `meta`（请求头） |
| `input` | `I` | 请求输入对象 |

返回 `GrpcToHttpPromise<I, O>` — 解析为 Axios 响应的 Promise。

### 示例

```typescript
// 在 Vue 组件中
const options: RpcOptions = {
    baseUrl: 'http://localhost:8000',
    meta: {
        'Authorization': 'token-value-here'
    }
};

// 生成的客户端自动使用 HTTP 而非 gRPC
const response = await client.sayHello({ name: 'World' }, options);
```

## 代码检查

```bash
npx tsc --noEmit
```

## 发布

```bash
npm publish --access=public
```

---

## 旧版本说明

本包的前身是 [@yyle88/grpt](https://www.npmjs.com/package/@yyle88/grpt)，由 [yyle88](https://github.com/yyle88) 发布。

由于 `yyle88` 账号已被封禁，`@yyle88/grpt` 不再维护。请使用 `@yylego/grpc-to-http` 替代。

---

## 📄 许可证类型

MIT 许可证 - 详见 [LICENSE](LICENSE)。

---

## 💬 联系与反馈

非常欢迎贡献代码！报告 BUG、建议功能、贡献代码：

- 🐛 **问题报告？** 在 GitHub 上提交问题并附上重现步骤
- 💡 **新颖思路？** 创建 issue 讨论
- 📖 **文档疑惑？** 报告问题，帮助我们完善文档
- 🚀 **需要功能？** 分享使用场景，帮助理解需求
- ⚡ **性能瓶颈？** 报告慢操作，协助解决性能问题
- 📢 **关注进展？** 关注仓库以获取新版本和功能
- 💬 **反馈意见？** 欢迎提出建议和意见

---

## 🔧 代码贡献

新代码贡献，请遵循此流程：

1. **Fork**：在 GitHub 上 Fork 仓库（使用网页界面）
2. **克隆**：克隆 Fork 的项目（`git clone https://github.com/username/grpc-to-http.git`）
3. **导航**：进入克隆的项目（`cd grpc-to-http`）
4. **分支**：创建功能分支（`git checkout -b feature/xxx`）
5. **编码**：实现更改并编写全面的测试
6. **测试**：运行 `npx tsc --noEmit` 检查 TypeScript 编译
7. **文档**：面向用户的更改需要更新文档
8. **暂存**：暂存更改（`git add .`）
9. **提交**：提交更改（`git commit -m "Add feature xxx"`）
10. **推送**：推送到分支（`git push origin feature/xxx`）
11. **PR**：在 GitHub 上打开 Merge Request（在 GitHub 网页上）并提供详细描述

请确保测试通过并包含相关的文档更新。

---

## 🌟 项目支持

非常欢迎通过提交 Merge Request 和报告问题来贡献此项目。

**项目支持：**

- ⭐ **给予星标** 如果项目对您有帮助
- 🤝 **分享项目** 给团队成员和前端开发朋友
- 📝 **撰写博客** 关于 gRPC 转 HTTP 的使用经验
- 🌟 **加入生态** - 致力于支持开源和前端开发场景

**祝你用这个包编程愉快！** 🎉🎉🎉
