import type { Engine, Register, Timer } from 'claude-code'

// Only turns that died because the machine could not reach the API; limits, billing and auth are left alone.
const NETWORK_KINDS = new Set(['unknown', 'server_error'])
const NETWORK =
  /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|ENETDOWN|fetch failed|socket hang up|connection (error|closed|reset|lost|dropped)|unable to connect|went to sleep|asleep|stopped arriving|network|timed? ?out|premature close/i
// The conversation outgrew the model's window.
const TOO_LONG = /prompt is too long|too many tokens|context (length|window|limit)|maximum context|exceeds? the (context|token)/i
const PROBE_URL = 'https://api.anthropic.com/' // any HTTP answer means the network is back
const FIRST_CHECK_MS = 10_000
const MAX_CHECK_MS = 60_000 // backoff: 10s, 20s, 40s, then every minute
const PROBE_TIMEOUT_MS = 8_000
const MAX_NUDGES = 5 // revivals in a row without an answered turn
const FULL_PERCENT = 95 // a turn that errors with the window this full hit the context limit

// The wait for the network; a fresh module (reload) starts with none and the engine drops old timers.
const wait = { id: 0, nextId: 0, timer: undefined as Timer | undefined, inFlight: false }

function stopWaiting($: Engine) {
  wait.id = 0
  wait.timer?.cancel()
  wait.timer = undefined
  $.ui.status(undefined)
}

function check($: Engine, id: number, delay: number, onUp: () => void) {
  wait.timer = $.clock.after(delay, () => {
    void (async () => {
      if (id !== wait.id) return
      let isUp = false
      if (!wait.inFlight) {
        wait.inFlight = true // at most one probe request open, even when the network hangs
        const fetched = $.http.fetch(PROBE_URL, { method: 'HEAD' }).then(
          () => true,
          () => false,
        )
        void fetched.then(() => {
          wait.inFlight = false
        })
        isUp = await Promise.race([fetched, $.clock.sleep(PROBE_TIMEOUT_MS).then(() => false)])
      }
      if (id !== wait.id) return
      if (isUp) {
        stopWaiting($)
        onUp()
        sendContinue($)
        return
      }
      // No deadline: a check a minute costs nothing, and he may be away for days.
      check($, id, Math.min(delay * 2, MAX_CHECK_MS), onUp)
    })()
  })
}

// One compaction per stretch without an answered turn, so a still-too-long conversation can't loop.
const compaction = { done: false }
// A failure we may answer with "continue". The session counts as unstuck once any main-loop turn
// answers after it (his, a peer's, a task's): then a "continue" is not sent, or dropped if already queued.
const nudge = { failure: false, answeredSince: false, pending: false }

function markFailure() {
  nudge.failure = true
  nudge.answeredSince = false
}

function sendContinue($: Engine) {
  if (nudge.answeredSince) {
    nudge.failure = false
    return
  }
  nudge.pending = true
  void $.prompt.submit({ text: 'continue' })
}

function compactThenContinue($: Engine, why: string) {
  if (compaction.done) return
  compaction.done = true
  markFailure()
  $.ui.status(`anti-hung: ${why}, compacting then continuing`)
  // After the failed turn has fully ended: compact, then pick the work back up.
  $.clock.after(1_000, () => {
    void $.session.compact().then(
      () => {
        $.ui.status(undefined)
        sendContinue($)
      },
      () => {
        $.ui.status(undefined)
        $.ui.toast('anti-hung: compaction failed, not continuing')
      },
    )
  })
}

// Self-update: when a newer anti-hung is installed, run /reload-plugins once the chat is idle,
// so every open chat picks it up without anyone typing into its input box.
const UPDATE_CHECK_MS = 5 * 60_000
const self = { loaded: '', asked: false, stop: undefined as (() => void) | undefined }

async function readJson($: Engine, path: string): Promise<{ version?: string; plugins?: Record<string, { version?: string }[]> } | undefined> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

// The newest version on disk: the registry's entry when running from the plugin cache, else the loaded folder's manifest.
async function installedVersion($: Engine): Promise<string | undefined> {
  const own = (await readJson($, `${$.plugin.root}/.claude-plugin/plugin.json`))?.version
  const registry = await readJson($, `${$.plugin.root}/../../../../installed_plugins.json`)
  const entry = Object.entries(registry?.plugins ?? {}).find(([key]) => key.startsWith(`${$.plugin.name}@`))?.[1]
  return entry?.map(e => e.version).find(v => v !== undefined && v !== own) ?? own
}

async function checkForUpdate($: Engine) {
  if (self.asked || !self.loaded) return
  const version = await installedVersion($)
  if (!version || version === self.loaded) return
  self.asked = true // once per loaded copy: the reload brings a fresh module
  await $.command.run({ command: 'reload-plugins' }).catch(() => {
    self.asked = false
  })
}

async function startUpdateChecks($: Engine) {
  self.loaded = (await readJson($, `${$.plugin.root}/.claude-plugin/plugin.json`))?.version ?? ''
  self.stop?.()
  self.stop = $.clock.every(UPDATE_CHECK_MS, () => {
    void checkForUpdate($)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await startUpdateChecks($)
    return next(e)
  }).catch(($, e, next) => next(e))

  let nudges = 0

  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e)
    // error_details is only the server's raw error body; a connection stop has none, and its
    // text ("Can't reach the API server … (ENOTFOUND)") is in last_assistant_message instead.
    const details = e.error_details || e.last_assistant_message || ''

    if (TOO_LONG.test(details)) {
      compactThenContinue($, 'prompt too long')
      return result
    }

    const isNetwork = NETWORK_KINDS.has(e.error) && NETWORK.test(details)
    if (!isNetwork || wait.id) return result
    if (nudges >= MAX_NUDGES) {
      $.ui.toast(`anti-hung: network dropped ${nudges} times in a row, not continuing again`)
      return result
    }
    markFailure()
    wait.id = ++wait.nextId
    $.ui.status('anti-hung: offline, will send "continue" when the network is back')
    check($, wait.id, FIRST_CHECK_MS, () => {
      nudges++
    })
    return result
  }).catch(($, e, next) => next(e))

  // An answered main-loop turn means the session is healthy again: start the counts over.
  // "Context limit reached" (auto-compact off) is the client's own stop, not an API error: the turn
  // just ends with reason 'error', so it is recognised by how full the window is.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      nudges = 0
      compaction.done = false
      if (nudge.failure) nudge.answeredSince = true // also while our "continue" sits in the queue
    }
    if (e.agentId === undefined && e.reason === 'error' && !wait.id) {
      const { context } = await $.session.usage()
      if ((context.percent ?? 0) >= FULL_PERCENT) compactThenContinue($, 'context limit reached')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The person typing takes over: stop waiting for the network, and a "continue" we queued earlier
  // (it runs only once the session is idle) is dropped instead of repeating work they already moved on.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = !e.origin || e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const isOurs = e.origin?.kind === 'plugin' && e.origin.name === $.plugin.name
    if (isPerson && wait.id) stopWaiting($)
    if (isOurs && nudge.pending) {
      nudge.pending = false
      nudge.failure = false
      if (nudge.answeredSince) return { drop: 'anti-hung: skipped "continue", the chat already moved on after the error' }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear or the end of the session: nothing left to continue.
  on('session.end', async ($, e, next) => {
    if (wait.id) stopWaiting($)
    return next(e)
  })
}
