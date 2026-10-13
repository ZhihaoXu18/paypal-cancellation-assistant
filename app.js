const express = require('express');
const path = require('node:path');

const app = express();
app.disable('x-powered-by');

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', application: 'paypal-cancellation-assistant' });
});

app.use(express.static(path.join(__dirname, 'public')));

module.exports = app;
