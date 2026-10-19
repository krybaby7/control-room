import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'./tests/performance',testMatch:'browser-performance.spec.ts',outputDir:'test-results-performance',fullyParallel:false,workers:1,forbidOnly:!!process.env.CI,retries:0,timeout:8*60*1000,globalTimeout:12*60*1000,expect:{timeout:30000},
 reporter:[['list'],['json',{outputFile:'browser-performance-results.json'}]],
 use:{baseURL:'http://127.0.0.1:4173',trace:'retain-on-failure',screenshot:'only-on-failure'},
 projects:[{name:'controlled-chromium',use:{browserName:'chromium'}}],
 webServer:{command:'node scripts/test-worker.mjs --target local-fixture --serve',url:'http://127.0.0.1:4173/api/workspace',reuseExistingServer:false,timeout:180000},
});
