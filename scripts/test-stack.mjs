// Dedicated disposable configuration; never use the application's Supabase root.
import {mkdirSync,copyFileSync,existsSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
const action=process.argv[2]
if (!['start','reset','stop','credentials'].includes(action)) throw new Error('Expected start/reset/stop/credentials')
const root=resolve('.local-tools/supabase-test')
const config=readFileSync('tests/supabase/config.toml','utf8')
if (!config.includes('project_id = "gradia-isolated-tests"') || config.includes('env(')) throw new Error('Unsafe test config')
mkdirSync(`${root}/supabase`,{recursive:true})
if(existsSync(`${root}/supabase/.temp/project-ref`)) throw new Error('Remote links forbidden')
copyFileSync('tests/supabase/config.toml',`${root}/supabase/config.toml`)
if (!existsSync(`${root}/supabase/migrations`)) symlinkSync(resolve('supabase/migrations'),`${root}/supabase/migrations`,'dir')
const args={start:['start'],reset:['db','reset','--local','--no-seed'],stop:['stop','--no-backup'],credentials:['status','-o','json']}[action]
const result=spawnSync('supabase',['--workdir',root,...args],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:'unix:///var/run/docker.sock'},maxBuffer:10*1024*1024})
// CLI startup/status can contain generated credentials. Never print raw output.
if(result.status!==0) {console.error('Disposable stack command failed; no credential-bearing output printed.');process.exit(1)}
if(action==='credentials') {
 const data=JSON.parse(result.stdout)
 if(data.API_URL!=='http://127.0.0.1:56531'||!data.ANON_KEY||!data.SERVICE_ROLE_KEY) throw new Error('Unexpected test endpoint')
 writeFileSync('.local-tools/test-db.json',JSON.stringify(data),{mode:0o600})
}
if(['start','reset'].includes(action)) {
 const fixture=spawnSync('docker',['exec','-i','supabase_db_gradia-isolated-tests','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{input:readFileSync('tests/sql/merge-failure.sql','utf8'),encoding:'utf8',env:{PATH:process.env.PATH,DOCKER_HOST:'unix:///var/run/docker.sock'}})
 if(fixture.status!==0) throw new Error('Disposable failure fixture setup failed')
}
console.log(`Disposable stack ${action} completed`)
