const path = require('node:path');
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  console.warn('Sandbox configuration is unavailable. The mock demo remains available.');
}

const fs = require('node:fs');
const { createApp } = require('./app');
const { createPayPal } = require('./lib/paypal');
const recoveryDirectory = path.join(__dirname, '.sandbox-runtime');
const recovered = [];
try {
  for (const name of fs.readdirSync(recoveryDirectory)) {
    if (/^[A-Za-z0-9-]+\.json$/.test(name)) {
      try { recovered.push(JSON.parse(fs.readFileSync(path.join(recoveryDirectory, name), 'utf8'))); }
      catch { console.warn('A Sandbox recovery record could not be loaded.'); }
    }
  }
} catch { /* No recovery records have been created yet. */ }
const app = createApp(createPayPal(process.env, fetch, recovered));

const host = '127.0.0.1';
const port = 3000;

const server = app.listen(port, host, () => {
  console.log(`Application started: http://${host}:${port}`);
});

server.on('error', (error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
});
