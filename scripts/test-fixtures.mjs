// Test-only SQL fixtures (injected failures, a notification clock) that the
// integration suites rely on. Applied after every disposable reset, by CI's
// test-stack.mjs and by the local record-fresh-reset.mjs, from this one list
// so the two never drift. Never applied to a shared database.
import {readFileSync} from 'node:fs'
export const TEST_FIXTURES=['tests/sql/merge-failure.sql','tests/sql/intake-link-failure.sql','tests/sql/whisper-failure.sql','tests/sql/notification-clock.sql','tests/sql/qualification-failure.sql']
export const fixtureSql=()=>TEST_FIXTURES.map(path=>readFileSync(path,'utf8')).join('\n')
