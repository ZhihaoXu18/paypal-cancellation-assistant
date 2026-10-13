# 付款授权审核助手

帮助电商商家发现「订单已取消，但 PayPal 付款授权仍未取消」的案件，供商家审核。当前仅为最小开发骨架，展示一笔明确标注的模拟订单：CAD 100、已取消、未发货、已授权但未收款。

当前不连接 PayPal，不执行任何支付操作，也不包含退款、数据库或 AI。

## 环境与安装

使用 Node.js 20.12.2 或更高版本与 npm。Express 5 要求 Node.js 18 或更高，本项目在 Node.js 20.12.2 上验证。

在项目目录运行：

```sh
npm install
```

已有锁文件时也可以使用 `npm ci` 进行可重复安装。本项目无需 `.env`，不会加载或修改该文件。

## 启动与访问

开发模式（修改服务端文件后自动重启）：

```sh
npm run dev
```

普通启动：

```sh
npm start
```

两种模式均仅监听 `127.0.0.1:3000`。浏览器访问 <http://127.0.0.1:3000>，按 Ctrl+C 停止服务。Node.js 20.12.2 的 watch 模式可能显示实验性功能提示，不影响启动。

健康接口：`GET http://127.0.0.1:3000/api/health`

```json
{"status":"ok","application":"paypal-cancellation-assistant"}
```

## 测试

```sh
npm test
```

使用 Node.js 内置测试工具，在本地随机端口启动测试服务，验证健康接口的 HTTP 状态、JSON 类型和响应内容，并关闭测试服务。

## 文件结构

```text
app.js                 Express 应用、健康接口与静态页面
server.js              固定本地地址和端口的启动入口
public/index.html      模拟订单与审核建议
public/styles.css      页面样式
public/app.js          前端健康状态检查
test/health.test.js    健康接口测试
package.json           依赖与启动、测试命令
package-lock.json      依赖版本锁定
.gitignore             忽略 node_modules、.env、.env.*、.DS_Store
```
