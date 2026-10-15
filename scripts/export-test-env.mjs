import {readFileSync,appendFileSync} from 'node:fs'
const data=JSON.parse(readFileSync('.local-tools/test-db.json','utf8'))
if(data.API_URL!=='http://127.0.0.1:56531'||!data.SERVICE_ROLE_KEY||!data.ANON_KEY||!process.env.GITHUB_ENV) throw new Error('Invalid disposable CI environment')
appendFileSync(process.env.GITHUB_ENV,`GRADIA_DISPOSABLE_TEST=gradia-isolated-tests\nSUPABASE_TEST_URL=${data.API_URL}\nSUPABASE_TEST_SERVICE_ROLE_KEY=${data.SERVICE_ROLE_KEY}\nSUPABASE_SERVICE_ROLE_KEY=${data.SERVICE_ROLE_KEY}\nSUPABASE_TEST_ANON_KEY=${data.ANON_KEY}\n`)
console.log('Validated disposable test environment exported without printing credentials')
