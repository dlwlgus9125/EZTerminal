const path = require('node:path');
module.exports = {
  testDir: __dirname, testMatch: 'prototype.spec.cjs', timeout: 90000, workers: 1,
  reporter: [['list'], ['json', { outputFile: path.join(__dirname, 'evidence', 'qa-report.json') }]],
  outputDir: path.join(__dirname, 'evidence', 'test-results'),
  use: { baseURL: 'http://127.0.0.1:4317', browserName: 'chromium', headless: true, viewport: {width:1440,height:900} },
};
