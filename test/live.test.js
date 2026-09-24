// How a usage response is judged. interpret() is pure, so every branch runs
// here without a network; the harness covers the same rules end to end.

const assert = require('assert')
const { interpret, retryAfterMs } = require('../lib/live.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}
const res = (status, body, headers) => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body), headers: headers || {} })

console.log('\n-- real usage is accepted --')
const good = interpret(res(200, { limits: [{ kind: 'session', percent: 5 }] }))
check('limits array -> ok', good.ok && good.utilization.limits[0].percent === 5)
check('an account with no limits is still valid data', interpret(res(200, { limits: [] })).ok)

console.log('\n-- a 200 is not proof of data --')
for (const [what, body] of [['empty object', {}], ['null', 'null'], ['an array', []], ['a string', '"hi"'],
  ['fields but no limits', { foo: 1 }]]) {
  const r = interpret(res(200, body))
  check(what + ' is rejected', !r.ok && /no usage data/.test(r.reason), JSON.stringify(r))
}
check('unparseable body is rejected', !interpret(res(200, '<html>')).ok)
const inband = interpret(res(200, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }))
check('an in-band rate_limit_error counts as rate-limited', !inband.ok && inband.rateLimited === true)
const other = interpret(res(200, { error: { type: 'overloaded_error', message: 'busy' } }))
check('other in-band errors are failures, not rate limits', !other.ok && !other.rateLimited && /busy/.test(other.reason))

console.log('\n-- 429 --')
const r429 = interpret(res(429, '', { 'retry-after': '90' }))
check('flagged as rate-limited', !r429.ok && r429.rateLimited === true)
check('Retry-After in seconds', r429.retryAfterMs === 90000, String(r429.retryAfterMs))
check('no Retry-After means 0, so the caller picks a default',
  interpret(res(429, '')).retryAfterMs === 0)

console.log('\n-- Retry-After forms --')
const now = Date.UTC(2026, 8, 24, 12, 0, 0)
check('HTTP date', retryAfterMs({ 'retry-after': 'Thu, 24 Sep 2026 12:05:00 GMT' }, now) === 300000)
check('a date in the past is 0, not negative', retryAfterMs({ 'retry-after': 'Thu, 24 Sep 2026 11:00:00 GMT' }, now) === 0)
check('garbage is 0', retryAfterMs({ 'retry-after': 'soon' }, now) === 0)
check('missing is 0', retryAfterMs({}, now) === 0)

console.log('\n-- the other statuses are unchanged --')
check('401', /not authorised/.test(interpret(res(401, '')).reason))
check('network error', interpret({ status: 0, body: '', error: 'ECONNRESET' }).reason === 'ECONNRESET')
check('500', /HTTP 500/.test(interpret(res(500, '')).reason))

console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'live usage tests failed')
