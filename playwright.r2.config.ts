import {defineConfig,devices} from '@playwright/test';
export default defineConfig({
 testDir:'./tests/e2e-r2',outputDir:'test-results-r2',fullyParallel:false,workers:1,forbidOnly:!!process.env.CI,retries:0,
 timeout:60000,expect:{timeout:15000},reporter:[['list']],
 use:{baseURL:'http://127.0.0.1:4173',trace:'retain-on-failure',screenshot:'only-on-failure'},
 projects:[{name:'chromium-r2',use:{...devices['Desktop Chrome']}}],
 webServer:{command:'node scripts/test-worker.mjs --target local-fixture --with-r2 --serve',url:'http://127.0.0.1:4173/api/workspace',reuseExistingServer:false,timeout:180000},
});
