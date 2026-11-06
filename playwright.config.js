const {defineConfig} = require('@playwright/test');
module.exports = defineConfig({
  testDir: 'tests',
  timeout: 60000,
  workers: 1,
  use: {baseURL: 'http://localhost:8123', launchOptions: {args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']}},
  webServer: {command: 'python3 -m http.server 8123 --directory docs', url: 'http://localhost:8123/waypoints.html', reuseExistingServer: true}
});
