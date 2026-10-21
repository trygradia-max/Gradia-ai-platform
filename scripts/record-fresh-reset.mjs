// Local only: resets the unlinked gradia-record-fresh disposable stack from this
// checkout's migrations, then applies the same test fixtures CI applies
// (scripts/test-fixtures.mjs). Without them, 14 tests in 6 suites fail locally
// while passing in CI. Never targets a linked or shared project.
import {existsSync,readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {fixtureSql} from './test-fixtures.mjs'
const workdir='.local-tools/record-fresh'
const config=readFileSync(`${workdir}/supabase/config.toml`,'utf8')
if (!config.includes('project_id = "gradia-record-fresh"') || config.includes('env(')) throw new Error('Unsafe record-fresh config')
if (existsSync(`${workdir}/supabase/.temp/project-ref`)) throw new Error('Remote links forbidden')
const env={PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:process.env.DOCKER_HOST??'unix:///var/run/docker.sock'}
const run=(cmd,args,input)=>spawnSync(cmd,args,{encoding:'utf8',env,input,maxBuffer:10*1024*1024})
// Output can contain generated credentials: report status only.
const reset=run('supabase',['--workdir',workdir,'db','reset','--local','--no-seed'])
const applied=(reset.stdout+reset.stderr).match(/Applying migration/g)?.length??0
// The CLI can exit non-zero on an unrelated unhealthy container after migrating.
if (reset.status!==0 && applied===0) {console.error('record-fresh reset failed before applying migrations');process.exit(1)}
const db='supabase_db_gradia-record-fresh'
const fixtures=run('docker',['exec','-i',db,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],fixtureSql())
if (fixtures.status!==0) {console.error('Test fixture setup failed');process.exit(1)}
run('docker',['exec',db,'psql','-U','postgres','-tAc',"NOTIFY pgrst, 'reload schema'"])
console.log(`record-fresh reset: ${applied} migrations and the test fixtures applied${reset.status!==0 ? ' (the CLI also reported a non-migration container issue)' : ''}`)
