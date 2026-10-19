import {defineConfig,devices} from '@playwright/test';
export default defineConfig({
 testDir:'./tests/e2e',fullyParallel:false,workers:1,forbidOnly:!!process.env.CI,retries:0,
 timeout:45000,maxFailures:process.env.CI?5:undefined,globalTimeout:process.env.CI?8*60*1000:undefined,expect:{timeout:15000},reporter:[['list']],
 use:{baseURL:'http://127.0.0.1:4173',trace:'retain-on-failure',screenshot:'only-on-failure'},
 projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
 webServer:{command:'node scripts/test-worker.mjs --target local-fixture --serve',url:'http://127.0.0.1:4173/api/workspace',reuseExistingServer:false,timeout:180000},
});
