const app = require('./app');

const host = '127.0.0.1';
const port = 3000;

const server = app.listen(port, host, () => {
  console.log(`应用已启动：http://${host}:${port}`);
});

server.on('error', (error) => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});
