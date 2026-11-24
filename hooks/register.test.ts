import { expect, mock, test } from 'claude-code/testing'

// The exact shape Claude Code sent on sma's real stop (17 Nov): no error_details for a connection failure.
const OFFLINE = { error: 'server_error', last_assistant_message: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)" } as const
const SLEPT = { error: 'server_error', last_assistant_message: 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.' } as const
const UP = { value: { status: 404, ok: false, headers: {}, text: '' } }

function setup(on: Parameters<Parameters<typeof test>[1]>[1], isOnline: () => boolean | 'hang') {
  const clock = mock.clock(on)
  const sent: string[] = []
  const compacted: boolean[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('classic.StopFailure', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.compact', () => {
    compacted.push(true)
    return { messages: [{ role: 'user', text: 'summary of the earlier conversation', toolUses: [] }] }
  })
  const usage = { percent: 40 }
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, percent: usage.percent, usd: 0, id: 's' }, rateLimits: [] } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const probes = { count: 0 }
  on('http.fetch', () => {
    probes.count++
    if (isOnline() === 'hang') return new Promise(() => {}) // a black-holed network never answers
    if (!isOnline()) throw new Error('getaddrinfo ENOTFOUND api.anthropic.com')
    return UP
  })
  return { clock, sent, compacted, probes, usage }
}

test('"continue" goes out once, right after the network comes back', async ($, on) => {
  let online = false
  const { clock, sent } = setup(on, () => online)

  await $.classic.StopFailure(OFFLINE)
  await clock.advance(60_000) // a minute offline: nothing sent
  expect(sent).toEqual([])

  online = true
  await clock.advance(10_000)
  expect(sent).toEqual(['continue'])

  await clock.advance(120_000) // and only once
  expect(sent).toEqual(['continue'])
})

test('a stop because the laptop slept mid-response also continues once the network is up', async ($, on) => {
  const { clock, sent } = setup(on, () => true)

  await $.classic.StopFailure(SLEPT)
  await clock.advance(10_000)
  expect(sent).toEqual(['continue'])
})

test('a weekly limit, billing or auth error is left alone', async ($, on) => {
  const { clock, sent } = setup(on, () => true)

  await $.classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your weekly limit" })
  await $.classic.StopFailure({ error: 'billing_error' })
  await $.classic.StopFailure({ error: 'authentication_failed', error_details: 'network' })
  await clock.advance(600_000)
  expect(sent).toEqual([])
})

test('typing while offline stops the wait', async ($, on) => {
  let online = false
  const { clock, sent } = setup(on, () => online)

  await $.classic.StopFailure(OFFLINE)
  await clock.advance(20_000)
  await $.prompt.submit({ text: 'something else' })
  sent.length = 0

  online = true
  await clock.advance(60_000)
  expect(sent).toEqual([])
})

test('a prompt-too-long error compacts once, then continues', async ($, on) => {
  const { clock, sent, compacted } = setup(on, () => true)

  await $.classic.StopFailure({ error: 'invalid_request', error_details: 'prompt is too long: 1023411 tokens > 1000000 maximum' })
  await clock.advance(2_000)
  expect(compacted.length).toBe(1)
  expect(sent).toEqual(['continue'])

  // a second one before any answered turn does not loop
  await $.classic.StopFailure({ error: 'invalid_request', error_details: 'prompt is too long: 1001000 tokens > 1000000 maximum' })
  await clock.advance(2_000)
  expect(compacted.length).toBe(1)
  expect(sent).toEqual(['continue'])
})

test('offline for days: keeps checking about once a minute, never more', async ($, on) => {
  const { clock, sent, probes } = setup(on, () => false)

  await $.classic.StopFailure(OFFLINE)
  await clock.advance(10 * 60_000)
  expect(probes.count).toBeLessThanOrEqual(13) // 10s, 20s, 40s, then about one a minute
  const before = probes.count
  await clock.advance(48 * 60 * 60_000) // two days away
  expect(probes.count - before).toBeGreaterThan(2_800) // still checking
  expect(probes.count - before).toBeLessThanOrEqual(48 * 60 + 1) // never more than one a minute
  expect(sent).toEqual([])
})

test('a network that hangs never stacks up requests', async ($, on) => {
  const { clock, probes } = setup(on, () => 'hang')

  await $.classic.StopFailure(OFFLINE)
  await clock.advance(30 * 60_000)
  expect(probes.count).toBe(1) // the one open request is never joined by another
})

const ERRORED_TURN = { answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'error' } as const

test('"Context limit reached" (window full, turn errored) compacts once, then continues', async ($, on) => {
  const { clock, sent, compacted, usage } = setup(on, () => true)
  usage.percent = 98

  await $.turn.complete(ERRORED_TURN)
  await clock.advance(2_000)
  expect(compacted.length).toBe(1)
  expect(sent).toEqual(['continue'])

  await $.turn.complete({ ...ERRORED_TURN, turnId: 't2' }) // still full: no loop
  await clock.advance(2_000)
  expect(compacted.length).toBe(1)
})

test('an errored turn with room in the window is not compacted', async ($, on) => {
  const { clock, sent, compacted, usage } = setup(on, () => true)
  usage.percent = 40

  await $.turn.complete(ERRORED_TURN)
  await clock.advance(5_000)
  expect(compacted.length).toBe(0)
  expect(sent).toEqual([])
})

const ANSWERED_TURN = { answer: 'done', durationMs: 5, isAborted: false, turnId: 't9', reason: 'answer' } as const

test('a turn that answers after the failure means the chat moved on: no "continue"', async ($, on) => {
  const { clock, sent, compacted } = setup(on, () => true)

  await $.classic.StopFailure({ error: 'invalid_request', error_details: 'prompt is too long: 1023411 tokens > 1000000 maximum' })
  await $.turn.complete(ANSWERED_TURN) // he compacted and asked something himself before ours finished
  await clock.advance(2_000)
  expect(compacted.length).toBe(1)
  expect(sent).toEqual([])
})

test('back online after a peer turn already answered: no "continue"', async ($, on) => {
  let online = false
  const { clock, sent } = setup(on, () => online)

  await $.classic.StopFailure(OFFLINE)
  await $.turn.complete(ANSWERED_TURN)
  online = true
  await clock.advance(60_000)
  expect(sent).toEqual([])
})

// The exact stop from 24 Nov: a stalled stream, error server_error / stream_idle_timeout, no error_details.
const STALLED = { error: 'server_error', last_assistant_message: 'API Error: The response stopped arriving. The response above may be incomplete.' } as const

test('a response that stopped arriving continues once the network answers', async ($, on) => {
  const { clock, sent } = setup(on, () => true)

  await $.classic.StopFailure(STALLED)
  await clock.advance(10_000)
  expect(sent).toEqual(['continue'])
})

test('a newer installed version reloads the plugins once, through the command API', async ($, on) => {
  const clock = mock.clock(on)
  let installed = '0.6.1'
  const runs: string[] = []
  on('fs.read', (_, e) => {
    if (String(e.path).endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ version: installed }) }
    throw new Error('ENOENT')
  })
  on('command.run', (_, e) => {
    runs.push(e.command)
    return { text: '' }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10 * 60_000)
  expect(runs).toEqual([]) // same version: nothing to do

  installed = '0.6.2'
  await clock.advance(5 * 60_000)
  expect(runs).toEqual(['reload-plugins'])

  await clock.advance(30 * 60_000)
  expect(runs).toEqual(['reload-plugins']) // only once per loaded copy
})
