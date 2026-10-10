/**
 * dsh-ai-token-saver — meter, digest, and nudge, so long sessions cost less.
 *
 * The agent-loop request is derived from the durable session log and arrives
 * DEEP-FROZEN at the `llm/stream` waterfall (mutating it throws by design), so
 * nothing here ever rewrites a request in flight. Everything is built on three
 * seams the host itself uses:
 *
 *   meter   `llm/stream` pass-through. Every model call — loop, compaction,
 *           digest alike — flows through this waterfall, and each adapter
 *           emits one `usage` chunk (TokenUsage: inputTokens is UNCACHED input
 *           only; billed input = input + cacheRead + cacheWrite). We observe,
 *           record a JSONL line per call, fold per-session/per-model totals,
 *           and keep a peak-per-session marker: when a later loop call bills
 *           far below the peak, the drop is counted as estimated savings —
 *           that is what compaction bought.
 *
 *   digest  After each `turn/end`, if the session billed more than
 *           `digest.everyTokens` since the last digest, ONE hand-built one-shot
 *           `ctx.llm.stream()` call merges the previous digest with the tail of
 *           the latest request's transcript into a compact rolling summary,
 *           written to `$DSH_HOME/ai-token-saver/digests/<session>.md`. A new
 *           session can then carry a dozen lines instead of replaying dozens
 *           of turns — that is the saving. The transcript comes from the
 *           latest observed request, which for the loop is a pure function of
 *           the session log anyway; content blocks are read defensively and
 *           unknown shapes are skipped, never guessed.
 *
 *   nudge   Per call, the model's context window is resolved once via
 *           `ctx.llm.resolveModelInfo` (the service compaction-basic itself
 *           uses). When the latest loop call's billed input crosses
 *           `pressure.ratio` of the window we record advice, and — only if
 *           `pressure.autoCompact` is on — the next `agent/pre-step` hands the
 *           session to the OFFICIAL engine: `ctx.compaction.compactIfNeeded(
 *           agent, 'pressure', signal)`. We never reimplement compaction; we
 *           only ask for it earlier than its own threshold would, and the
 *           engine still decides.
 *
 * Config lives at `$DSH_HOME/ai-token-saver/config.json` (same convention as
 * the sibling dsh-ui-video-background: seeded on first load, clamped on read,
 * a broken file degrades to defaults and never takes the host down). An
 * aggregate `stats.json` and a same-origin `/dsh-ai-token-saver/stats` route
 * expose what was measured; nothing leaves the machine except model calls the
 * user already makes.
 *
 * Zero dependencies: the host supplies `llm` (injected); `compaction` and
 * `webServer` are consumed only when present (`ctx.get` / `ctx.inject`).
 *
 * @module dsh-ai-token-saver
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'ai-token-saver'

/** Same-origin route reporting the aggregate stats; humans and dashboards fetch it. */
const STATS_ROUTE = '/dsh-ai-token-saver/stats'

const PLUGIN_DIR = 'ai-token-saver'

/**
 * Effective config defaults. The digest threshold is deliberately high so the
 * summarizer call pays for itself: 50k billed tokens between digests dwarfs
 * the ~1k-token call. Empty `digest.provider`/`digest.model` = reuse whatever
 * route the session itself last used.
 */
const DEFAULTS = {
  enabled: true,
  ledger: {
    enabled: true,
    maxFileBytes: 4 * 1024 * 1024,
    recentCalls: 50,
  },
  digest: {
    enabled: true,
    everyTokens: 50000,
    maxSourceChars: 16000,
    maxOutputChars: 1200,
    maxTokens: 800,
    temperature: 0.2,
    keepLast: 12,
    provider: '',
    model: '',
  },
  pressure: {
    ratio: 0.6,
    autoCompact: false,
    cooldownMinutes: 15,
  },
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v, fallback, lo, hi) => (Number.isFinite(v) ? clamp(v, lo, hi) : fallback)

function dshHome() {
  return process.env.DSH_HOME === undefined || process.env.DSH_HOME === '' ? join(homedir(), '.dsh') : process.env.DSH_HOME
}

function pluginHome() {
  return join(dshHome(), PLUGIN_DIR)
}

function configPath() {
  return join(pluginHome(), 'config.json')
}

function digestsDir() {
  return join(pluginHome(), 'digests')
}

/** Read the config, seeding the file once so the user has something to edit. */
function readConfigUncached() {
  const path = configPath()
  try {
    if (!existsSync(path)) {
      mkdirSync(pluginHome(), { recursive: true })
      writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + '\n', { flag: 'wx' })
    }
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const obj = (v) => (v !== null && typeof v === 'object' ? v : {})
    const ledger = obj(raw.ledger)
    const digest = obj(raw.digest)
    const pressure = obj(raw.pressure)
    return {
      enabled: raw.enabled !== false,
      ledger: {
        enabled: ledger.enabled !== false,
        maxFileBytes: num(ledger.maxFileBytes, DEFAULTS.ledger.maxFileBytes, 65536, 256 * 1024 * 1024),
        recentCalls: num(ledger.recentCalls, DEFAULTS.ledger.recentCalls, 5, 500),
      },
      digest: {
        enabled: digest.enabled !== false,
        everyTokens: num(digest.everyTokens, DEFAULTS.digest.everyTokens, 1000, 10 * 1024 * 1024),
        maxSourceChars: num(digest.maxSourceChars, DEFAULTS.digest.maxSourceChars, 1000, 200000),
        maxOutputChars: num(digest.maxOutputChars, DEFAULTS.digest.maxOutputChars, 200, 8000),
        maxTokens: num(digest.maxTokens, DEFAULTS.digest.maxTokens, 100, 8192),
        temperature: num(digest.temperature, DEFAULTS.digest.temperature, 0, 2),
        keepLast: num(digest.keepLast, DEFAULTS.digest.keepLast, 1, 200),
        provider: typeof digest.provider === 'string' ? digest.provider : '',
        model: typeof digest.model === 'string' ? digest.model : '',
      },
      pressure: {
        ratio: num(pressure.ratio, DEFAULTS.pressure.ratio, 0.05, 1),
        autoCompact: pressure.autoCompact === true,
        cooldownMinutes: num(pressure.cooldownMinutes, DEFAULTS.pressure.cooldownMinutes, 1, 24 * 60),
      },
    }
  } catch (error) {
    // A broken config must not take the feature down; degrade to defaults.
    return structuredClone(DEFAULTS)
  }
}

/** Config reads are hot (per call / per step); cache for a few seconds. */
function makeConfigReader() {
  let cached = null
  let at = 0
  return function readConfig() {
    const now = Date.now()
    if (cached === null || now - at > 5000) {
      cached = readConfigUncached()
      at = now
    }
    return cached
  }
}

/** Session ids are branded strings; keep only what a filename and a map key tolerate. */
function safeId(raw) {
  const s = String(raw ?? 'unknown')
  const clean = s.replace(/[^A-Za-z0-9._-]+/g, '_')
  return clean.length > 0 && clean.length <= 120 ? clean : 'unknown'
}

/** Total text length of one message's model-facing blocks; unknown shapes count 0. */
function contentChars(content) {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') total += block.text.length
    else if (block.type === 'tool-call' && typeof block.arguments === 'string') total += block.arguments.length
  }
  return total
}

const ROLE_LABEL = { system: 'system', developer: 'developer', user: 'user', assistant: 'assistant', tool: 'tool-result' }

/**
 * Transcript tail from the latest observed request — the digest source.
 *
 * Reads only shapes verified in `@deepseek-ai/dsh-llm` (text/reasoning/
 * tool-call blocks, string content); anything else is skipped, not guessed.
 * Tool-call arguments and tool results are truncated hard — they are the
 * bulk, not the gist. Returns '' when nothing readable was found.
 */
function extractTranscript(messages, maxChars) {
  if (!Array.isArray(messages)) return ''
  const lines = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) continue
    const role = ROLE_LABEL[message.role] ?? 'message'
    for (const block of message.content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        const text = message.role === 'tool' ? block.text.trim().slice(0, 600) : block.text.trim()
        lines.push(role + ': ' + text)
      } else if (block.type === 'tool-call' && typeof block.name === 'string') {
        const args = typeof block.arguments === 'string' ? block.arguments.slice(0, 200) : ''
        lines.push(role + ': [tool-call ' + block.name + '] ' + args)
      }
    }
  }
  let text = lines.join('\n')
  if (text.length > maxChars) text = '…(earlier turns cut)…\n' + text.slice(text.length - maxChars)
  return text
}

function buildDigestPrompt(prev, transcript, maxOutputChars) {
  return [
    '你在为一个 AI Agent 工作台维护“会话滚动摘要”。目的是：用户在新会话里只需携带这份摘要，而不必重放几十轮历史，从而节省 token。',
    '下面先给出当前摘要（可能为空），再给出其后新发生的对话记录（可能从头截断）。',
    '请输出合并后的新摘要：',
    '- 保留：用户的最终目标；已做出的关键决定；重要事实、约束与路径；尚未完成的任务与下一步；用户的明确偏好。',
    '- 丢弃：寒暄、重复内容、已被推翻或不再相关的中间过程。',
    '- 用对话的主要语言书写；直接输出摘要正文，不要加“摘要：”之类的标题，不要解释你在做什么。',
    '- 全文不超过 ' + maxOutputChars + ' 字符。',
    '',
    '【当前摘要】',
    prev === '' ? '（无）' : prev,
    '',
    '【新对话记录】',
    transcript === '' ? '（无可读记录）' : transcript,
  ].join('\n')
}

function appendJsonl(path, obj, maxFileBytes) {
  try {
    mkdirSync(pluginHome(), { recursive: true })
    try {
      if (existsSync(path) && statSync(path).size > maxFileBytes) {
        renameSync(path, path + '.1')
      }
    } catch (error) {} // rotation is best-effort; the append below still runs
    appendFileSync(path, JSON.stringify(obj) + '\n')
  } catch (error) {} // disk trouble must never reach the model stream
}

function readTextIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch (error) {
    return ''
  }
}

/**
 * The plugin. Nothing is registered when `enabled` is false — exactly the
 * sibling's kill-switch semantics (turning it back on needs a restart, since
 * the bundle is assembled at process start).
 *
 * @param ctx - plugin context (`llm` injected; `compaction`/`webServer` optional).
 */
export function apply(ctx) {
  const config = readConfigUncached()
  const readFreshConfig = makeConfigReader()
  const log = ctx.logger ?? console

  if (config.enabled === false) {
    log.info?.('ai-token-saver: enabled=false in %s — nothing registered (restart to re-enable)', configPath())
    return
  }

  // ---- state -----------------------------------------------------------

  /** One folded record per finished call; also the JSONL line body. */
  const recentCalls = []
  const byModel = new Map() // 'provider|model' -> folded totals
  const sessions = new Map() // safeId -> { calls, billedInput, output, cacheRead, peakBilledInput, ... }
  const savings = { tokens: 0, events: 0 }
  const advice = [] // last N pressure advisories
  const digestIndex = [] // { sessionId, file, updatedAt, chars } newest first
  const tokensSinceDigest = new Map() // safeId -> billed input+output since last digest
  const windowCache = new Map() // 'provider|model' -> { window|null, at }
  let lastRequest = null // { provider, model, sessionId, messages, at }
  let digestInFlight = false
  let lastNudgeAt = 0
  let nudgePending = false

  // Re-index digests left by previous runs so the keepLast cap sees them.
  try {
    const dir = digestsDir()
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue
        const stat = statSync(join(dir, file))
        digestIndex.push({ sessionId: file.slice(0, -3), file, updatedAt: stat.mtime.toISOString(), chars: stat.size })
      }
      digestIndex.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    }
  } catch (error) {}

  // ---- folding ---------------------------------------------------------

  function foldUsage(record, usage) {
    // Disjoint counters (see TokenUsage): billed input sums all three.
    const billedInput = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    record.billedInput = billedInput
    record.output = usage.outputTokens ?? 0
    record.cacheRead = usage.cacheReadTokens ?? 0
    record.cacheWrite = usage.cacheWriteTokens ?? 0

    const modelKey = record.provider + '|' + record.model
    let modelTotals = byModel.get(modelKey)
    if (!modelTotals) byModel.set(modelKey, (modelTotals = { calls: 0, billedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }))
    modelTotals.calls += 1
    modelTotals.billedInput += billedInput
    modelTotals.output += record.output
    modelTotals.cacheRead += record.cacheRead
    modelTotals.cacheWrite += record.cacheWrite

    // Only genuine loop calls (agent-session requests) count as session
    // activity: aux calls (compaction/title) and our own digest call would
    // otherwise fake savings, pressure, and digest cadence.
    if (!record.isLoop) return

    let session = sessions.get(record.sessionId)
    if (!session) sessions.set(record.sessionId, (session = { calls: 0, billedInput: 0, output: 0, cacheRead: 0, peakBilledInput: 0, lastTs: 0, contextWindow: null, pressure: null }))
    session.calls += 1
    session.billedInput += billedInput
    session.output += record.output
    session.cacheRead += record.cacheRead
    session.lastTs = record.ts

    // Savings estimate: a LOOP call billing far below the session's peak
    // means the context shrank since that peak — almost always the official
    // engine replacing a history span with one summary node. Credit the
    // drop, then re-base.
    if (session.peakBilledInput > 0 && billedInput < session.peakBilledInput * 0.9) {
      savings.tokens += session.peakBilledInput - billedInput
      savings.events += 1
    }
    session.peakBilledInput = Math.max(session.peakBilledInput, billedInput)

    tokensSinceDigest.set(record.sessionId, (tokensSinceDigest.get(record.sessionId) ?? 0) + billedInput + record.output)
  }

  function pushAdvice(level, message) {
    advice.push({ ts: new Date().toISOString(), level, message })
    if (advice.length > 20) advice.shift()
  }

  /** Resolve the context window once per route; null on failure, retried later. */
  async function contextWindow(provider, model) {
    const key = provider + '|' + model
    const hit = windowCache.get(key)
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.window
    let window = null
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      const w = info && info.context ? info.context.contextWindow : null
      if (Number.isFinite(w) && w > 0) window = w
    } catch (error) {} // unknown route: keep advising with pressure=null
    windowCache.set(key, { window, at: Date.now() })
    return window
  }

  /** After each finished call: pressure check (advice now, nudge at pre-step). */
  function schedulePressureCheck(record) {
    void (async () => {
      try {
        if (!record.isLoop) return // aux calls ride along; judge the loop
        const configNow = readFreshConfig()
        const session = sessions.get(record.sessionId)
        if (!session) return
        // The latest loop call's billed input ≈ the context size the model
        // just re-read; the cumulative sum is spend, not pressure.
        const window = await contextWindow(record.provider, record.model)
        session.contextWindow = window ?? session.contextWindow
        session.pressure = window ? record.billedInput / window : null
        if (window && session.pressure >= configNow.pressure.ratio) {
          // Cooldown: one advisory (and at most one nudge) per interval.
          if (Date.now() - lastNudgeAt >= configNow.pressure.cooldownMinutes * 60 * 1000) {
            lastNudgeAt = Date.now()
            const pct = Math.round(session.pressure * 100)
            pushAdvice(
              'warn',
              'session ' + record.sessionId + ': latest call billed ' + record.billedInput + ' input tokens (' + pct +
                '% of ' + record.model + "'s window) — consider /compact; " +
                (configNow.pressure.autoCompact ? 'autoCompact will nudge the engine at the next pre-step' : 'autoCompact is off'),
            )
            if (configNow.pressure.autoCompact) nudgePending = true
          }
        }
        flushStats() // keep the snapshot as fresh as the pressure number
      } catch (error) {} // the advisory must never break the call path
    })()
  }

  // ---- the digest ------------------------------------------------------

  function digestPath(sessionId) {
    return join(digestsDir(), safeId(sessionId) + '.md')
  }

  function readDigest(sessionId) {
    return readTextIfExists(digestPath(sessionId)).trim()
  }

  function writeDigest(sessionId, text) {
    try {
      mkdirSync(digestsDir(), { recursive: true })
      writeFileSync(digestPath(sessionId), text + '\n', 'utf8')
      const entry = { sessionId, file: safeId(sessionId) + '.md', updatedAt: new Date().toISOString(), chars: text.length }
      const existing = digestIndex.findIndex((e) => e.sessionId === entry.sessionId)
      if (existing >= 0) digestIndex.splice(existing, 1)
      digestIndex.unshift(entry)
      // Cap the index AND the files: a digest nobody can find saves nothing.
      const configNow = readFreshConfig()
      while (digestIndex.length > configNow.digest.keepLast) {
        const dropped = digestIndex.pop()
        try {
          unlinkSync(join(digestsDir(), dropped.file))
        } catch (error) {}
      }
    } catch (error) {
      log.warn?.('ai-token-saver: could not write digest:', error?.message ?? error)
    }
  }

  function maybeDigest() {
    void (async () => {
      try {
        const configNow = readFreshConfig()
        if (!configNow.digest.enabled || digestInFlight) return
        const last = lastRequest
        if (!last || !Array.isArray(last.messages) || last.messages.length === 0) return
        const since = tokensSinceDigest.get(last.sessionId) ?? 0
        if (since < configNow.digest.everyTokens) return

        const provider = configNow.digest.provider !== '' ? configNow.digest.provider : last.provider
        const model = configNow.digest.model !== '' ? configNow.digest.model : last.model
        if (provider === '' || model === '') return

        digestInFlight = true
        try {
          const prev = readDigest(last.sessionId)
          const transcript = extractTranscript(last.messages, configNow.digest.maxSourceChars)
          const prompt = buildDigestPrompt(prev, transcript, configNow.digest.maxOutputChars)
          let text = ''
          // Hand-built one-shot: RequestUserInput is exactly
          // { role:'user', content: ContentBlock[] }; purpose stays unset.
          const stream = ctx.llm.stream({
            provider,
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            maxTokens: configNow.digest.maxTokens,
            temperature: configNow.digest.temperature,
          })
          for await (const chunk of stream) {
            if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            else if (chunk && chunk.type === 'finish') break
          }
          text = text.trim()
          if (text !== '') {
            writeDigest(last.sessionId, text)
            tokensSinceDigest.set(last.sessionId, 0)
            log.info?.('ai-token-saver: digest for session %s refreshed (%s chars, after %s billed tokens)', last.sessionId, text.length, since)
          }
        } finally {
          digestInFlight = false
        }
      } catch (error) {
        digestInFlight = false
        log.warn?.('ai-token-saver: digest failed (session continues unaffected):', error?.message ?? error)
      }
    })()
  }

  // ---- seams -----------------------------------------------------------

  // 1) Meter: pass-through observer around EVERY model call. Loop-built
  //    requests are deep-frozen; we only read. Downstream errors propagate
  //    untouched — the record is written, then the error re-thrown.
  ctx.on('llm/stream', (options, next) => {
    if (!readFreshConfig().ledger.enabled) return next()
    const purpose = options.purpose === 'compaction' || options.purpose === 'session-title' ? options.purpose : undefined
    const rawSessionId = options.sessionId ?? null
    const sessionId = safeId(rawSessionId ?? 'unknown')
    // A genuine loop request: no aux purpose AND a real session identity.
    // Hand-built one-shots (our digest, custom tools) fail one of the two.
    const isLoop = purpose === undefined && rawSessionId !== null
    const record = {
      ts: Date.now(),
      provider: String(options.provider ?? ''),
      model: String(options.model ?? ''),
      purpose,
      isLoop,
      sessionId,
      promptTokensEst: Math.round(contentChars(options.messages) / 4),
      toolCount: Array.isArray(options.tools) ? options.tools.length : 0,
    }
    if (isLoop && Array.isArray(options.messages) && options.messages.length > 0) {
      // Latest loop transcript = the digest source. Frozen object: read-only.
      lastRequest = { provider: record.provider, model: record.model, sessionId, messages: options.messages, at: record.ts }
    }
    let stream
    try {
      stream = next()
    } catch (error) {
      record.error = String(error?.message ?? error)
      finish(record)
      throw error
    }
    return (async function* () {
      try {
        for await (const chunk of stream) {
          if (chunk && chunk.type === 'usage' && chunk.usage) foldUsage(record, chunk.usage)
          yield chunk
        }
        finish(record)
      } catch (error) {
        record.error = String(error?.message ?? error)
        finish(record)
        throw error
      }
    })()
  })

  function finish(record) {
    record.at = new Date(record.ts).toISOString()
    if (record.billedInput === undefined) record.billedInput = 0
    if (record.output === undefined) record.output = 0
    recentCalls.push(record)
    if (recentCalls.length > readFreshConfig().ledger.recentCalls) recentCalls.shift()
    // Durable history survives restarts (stats.json is just a snapshot).
    appendJsonl(join(pluginHome(), 'usage.jsonl'), record, readFreshConfig().ledger.maxFileBytes)
    flushStats()
    schedulePressureCheck(record)
  }

  // 2) Nudge: hand the session to the OFFICIAL compaction engine earlier than
  //    its own threshold would. The engine still decides; we only ask.
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (nudgePending) {
        nudgePending = false
        const engine = ctx.get('compaction')
        if (engine && typeof engine.compactIfNeeded === 'function' && payload && payload.agent && payload.signal) {
          const result = await engine.compactIfNeeded(payload.agent, 'pressure', payload.signal)
          if (result) pushAdvice('info', 'compaction engine compacted a span after the pressure nudge')
        }
      }
    } catch (error) {
      log.warn?.('ai-token-saver: compaction nudge failed (step continues):', error?.message ?? error)
    }
    return next()
  })

  // 3) Digest tick: after each turn, if the session earned one.
  ctx.on('turn/end', () => {
    maybeDigest()
  })

  // ---- stats -----------------------------------------------------------

  function statsPayload() {
    const sessionsOut = {}
    for (const [sid, s] of sessions) {
      sessionsOut[sid] = {
        calls: s.calls,
        billedInput: s.billedInput,
        output: s.output,
        cacheRead: s.cacheRead,
        contextWindow: s.contextWindow,
        pressure: s.pressure,
        lastTs: s.lastTs ? new Date(s.lastTs).toISOString() : null,
      }
    }
    const totals = { calls: 0, billedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimatedSavingsTokens: savings.tokens, savingsEvents: savings.events }
    for (const m of byModel.values()) {
      totals.calls += m.calls
      totals.billedInput += m.billedInput
      totals.output += m.output
      totals.cacheRead += m.cacheRead
      totals.cacheWrite += m.cacheWrite
    }
    const configNow = readFreshConfig()
    return {
      plugin: 'dsh-ai-token-saver',
      version: '0.1.0',
      updatedAt: new Date().toISOString(),
      configFile: configPath(),
      totals,
      byModel: Object.fromEntries(byModel),
      sessions: sessionsOut,
      advice,
      digests: digestIndex.slice(0, configNow.digest.keepLast),
      recentCalls: recentCalls.slice(-configNow.ledger.recentCalls).map((r) => ({ at: r.at, provider: r.provider, model: r.model, purpose: r.purpose ?? null, sessionId: r.sessionId, promptTokensEst: r.promptTokensEst, billedInput: r.billedInput, output: r.output, error: r.error ?? null })),
    }
  }

  function flushStats() {
    try {
      mkdirSync(pluginHome(), { recursive: true })
      writeFileSync(join(pluginHome(), 'stats.json'), JSON.stringify(statsPayload(), null, 2) + '\n')
    } catch (error) {} // best-effort; the route recomputes on demand
  }

  ctx.effect(() => {
    const timer = setInterval(flushStats, 30 * 1000)
    return () => clearInterval(timer)
  }, 'ai-token-saver: periodic stats flush')

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: STATS_ROUTE,
          handler: (req, res) => {
            try {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(statsPayload()))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ error: String(error) }))
            }
          },
        }),
      'ai-token-saver: GET ' + STATS_ROUTE,
    )
  })

  log.info?.('ai-token-saver: metering on %s; config at %s', STATS_ROUTE, configPath())
}
