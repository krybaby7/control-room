import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'./tests/acceptance',outputDir:'test-results-acceptance',fullyParallel:false,workers:1,forbidOnly:!!process.env.CI,retries:0,
 timeout:90000,globalTimeout:process.env.CI?12*60*1000:undefined,maxFailures:process.env.CI?5:undefined,expect:{timeout:15000},
 reporter:[['list'],['json',{outputFile:'acceptance-results.json'}]],
 use:{baseURL:'http://127.0.0.1:4173',trace:'retain-on-failure',screenshot:'only-on-failure'},
 projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'firefox',use:{browserName:'firefox'}},{name:'webkit',use:{browserName:'webkit'}}],
 webServer:{command:'node scripts/test-worker.mjs --target local-fixture --serve',url:'http://127.0.0.1:4173/api/workspace',reuseExistingServer:false,timeout:180000},
});
