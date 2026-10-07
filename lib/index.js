/**
 * Host half of dsh-ui-video-background.
 *
 * Puts a local video behind the DSH interface and turns its panels into liquid
 * glass. The look is ONE scrim, never stacked translucency: everything visible
 * of the video passes through exactly one layer of the chosen alpha.
 * Everything happens in two index rows plus three routes, so there is no
 * client bundle and nothing in the client module graph:
 *
 *   style  makes the big surfaces translucent. DSH declares its whole palette
 *          on `body` (`body[data-ds-dark-theme]` for the dark set) and every
 *          panel paints from an alias token, so overriding the aliases — in
 *          terms of the *static* palette, which keeps it non-circular — is what
 *          the design system itself does (`--dsw-menu-surface-fill:#f8f9fa94`,
 *          `color-mix(in srgb, var(--dsw-alias-bg-layer-1) 75%, transparent)`).
 *          `!important` is required because the app declares on the same
 *          element.
 *   script mounts a fixed full-viewport <video> (z-index -2) plus ONE dimming
 *          scrim (z-index -1, hex alpha — it is a child of <html>, so body's
 *          tokens are invisible to it) while <head> is still parsing, re-runs
 *          the SAME style builder against the live config, tags translucent
 *          panels with the glass recipe, CLEAR-TAGS any structural sheet
 *          spanning ≥95% of either viewport dimension (the app nests frame ×
 *          full-height columns; leaving one translucent layer on each would
 *          multiply with the scrim and wash the video out — the v0.2.1 bug —
 *          so they are zeroed by geometry, not by hashed class names), and
 *          POSTs one DOM snapshot to /diag so a "cannot see it" report needs
 *          no screenshot.
 *   route  /video streams the file same-origin (the document CSP is tight and
 *          <video> may seek, so Range is honoured); /config reports the
 *          effective config — plus `extraCss`, the contents of
 *          `$DSH_HOME/ui-video-background/style.css`, appended last to the
 *          live <style> so CSS tuning takes effect on a bare refresh;
 *          /diag accepts the one local snapshot POST (never leaves the host).
 *
 * Liquid glass: `backdrop-filter` cannot be reached through a custom property
 * alone (panels paint their background from the alias tokens, nothing selects
 * them by class — the hashed CSS-module names break on every app update), so
 * the injected script finds the frosted surfaces structurally instead: any
 * div/aside/section/main that is large enough, is painted with a *translucent*
 * background (which before this plugin only hover chips are, and menus — which
 * are skipped because they already have the native `blur(40px) saturate(150%)`
 * from `--dsw-menu-backdrop-filter`), and has no already-glassy ancestor gets
 * the class the style row decorates: backdrop blur + saturate (the app's own
 * menu recipe), an inset 1px rim + hairline stroke, and a top sheen gradient.
 *
 * Config: `$DSH_HOME/ui-video-background/config.json`, written with defaults
 * on first load. Nothing is baked when disabled or when the file is missing —
 * translucent panels with no video behind them would be worse than no feature.
 * The page re-reads the config on every load and applies it with a later
 * `<style>` element, so editing it — or dropping CSS into
 * `$DSH_HOME/ui-video-background/style.css`, which rides along as `extraCss`
 * and wins the cascade — needs only a refresh once the host has restarted at
 * least once on this version; the baked style row only exists so the first
 * paint (before the fetch resolves) is already correct.
 *
 * @module dsh-ui-video-background
 */

import { dirname, extname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'ui-video-bg'

/** Same-origin route that serves the configured video. */
const VIDEO_ROUTE = '/dsh-ui-video-background/video'
/** Same-origin route reporting the effective config; the page fetches it live. */
const CONFIG_ROUTE = '/dsh-ui-video-background/config'
/** Same-origin route the page POSTs one DOM snapshot to (stays local). */
const DIAG_ROUTE = '/dsh-ui-video-background/diag'
/** Marker class on <html> the injected style keys off. */
const MARKER = 'dsh-uivb'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
/** Fallback asset: the package ships one, so a fresh install has an effect. */
const BUNDLED_VIDEO = join(PACKAGE_DIR, 'assets', 'background.mp4')

/**
 * Effective config defaults; `video: null` means the bundled asset.
 *
 * `surfaceAlpha`/`sidebarAlpha` are how much of the solid panel colour
 * survives: 0.68/0.74 keeps text crisp while the video still reads through.
 * `glass` is the backdrop blur radius in px (the app's own menu glass uses
 * 40; panels use less because they are far larger). 0 = pure translucency.
 */
const DEFAULTS = {
  enabled: true,
  video: null,
  opacity: 0.85,
  blur: 0,
  surfaceAlpha: 0.68,
  sidebarAlpha: 0.74,
  glass: 24,
  clearStructural: true,
  scrim: true,
}

/**
 * The entire visual contract, as ONE pure function.
 *
 * It is deliberately free of Node APIs and outer-scope references because it
 * is serialized with `.toString()` into the injected script and re-runs in the
 * page against the live config — one source of truth for both sides.
 *
 * @param config - effective config object.
 * @param marker - class marker (`dsh-uivb`), also prefixes the custom props.
 * @returns the whole stylesheet as one string.
 */
function buildStyle(config, marker) {
  var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }
  var num = function (v, fallback) { return Number.isFinite(v) ? v : fallback }
  var pct = function (v, floor) { return Math.round(clamp(v, floor, 1) * 100) }
  var sc = function (tone) { return 'var(--dsw-static-neutral-' + tone + ')' }
  // The palette the app itself declares for these aliases, per theme, as
  // static tokens; rim/hair/sheen are the glass edge colors, per theme.
  var LIGHT = { base: 'bluish-00', layer1: 'bluish-00', layer2: 'bluish-00', layer3: 'bluish-00', sidebar: 'bluish-50', rim: '#ffffffcc', hair: '#00000014', sheen: '#ffffff4d' }
  var DARK = { base: 'bluish-950', layer1: 'bluish-875', layer2: 'bluish-850', layer3: 'bluish-800', sidebar: 'bluish-900', rim: '#ffffff33', hair: '#ffffff1a', sheen: '#ffffff14' }
  var bleed = 24
  var glass = clamp(num(config.glass, 0), 0, 48)
  var opacity = clamp(num(config.opacity, 1), 0, 1)
  var blur = clamp(num(config.blur, 0), 0, 12)
  var surfaceAlpha = clamp(num(config.surfaceAlpha, 1), 0.15, 1)
  var sidebarAlpha = clamp(num(config.sidebarAlpha, 1), 0.15, 1)
  var surface = pct(surfaceAlpha, 0.15)
  // Raised layers keep a little more opacity so hierarchy survives
  // translucency; otherwise layer-1/2 and the page collapse into one wash.
  var raised = pct(clamp(surfaceAlpha + 0.12, 0.15, 1), 0.15)
  var sidebar = pct(sidebarAlpha, 0.15)
  // ONE dimming layer between video and content: nested translucent structural
  // layers multiply into a smear, so the frame is zeroed and this scrim carries
  // the whole surfaceAlpha instead. Hex alpha so it works without the tokens
  // (the scrim is a child of <html>; body's custom properties are not visible).
  var scrimHx = ('0' + Math.round(surfaceAlpha * 255).toString(16)).slice(-2)
  var block = function (selector, p) {
    return selector + '{' +
      '--dsw-alias-bg-base:color-mix(in srgb,' + sc(p.base) + ' ' + surface + '%,transparent) !important;' +
      '--dsw-alias-bg-layer-1:color-mix(in srgb,' + sc(p.layer1) + ' ' + raised + '%,transparent) !important;' +
      '--dsw-alias-bg-layer-2:color-mix(in srgb,' + sc(p.layer2) + ' ' + raised + '%,transparent) !important;' +
      '--dsw-alias-bg-layer-3:color-mix(in srgb,' + sc(p.layer3) + ' ' + raised + '%,transparent) !important;' +
      '--dsw-specific-sidebar-fill:color-mix(in srgb,' + sc(p.sidebar) + ' ' + sidebar + '%,transparent) !important;' +
      '--' + marker + '-rim:' + p.rim + ';' +
      '--' + marker + '-hair:' + p.hair + ';' +
      '--' + marker + '-sheen:' + p.sheen + ';}'
  }
  var rows = [
    // The desktop carrier paints html itself; the video cannot show through it.
    'html.' + marker + '{background-color:transparent !important}',
    // Translucent layers MULTIPLY: body 68% over frame 68% over col 68% leaves
    // the video a barely-visible smear. So the structural sheets (html, body,
    // and — via the clear class, tagged at runtime — every element covering
    // essentially the whole viewport) go FULLY transparent, and only genuine
    // sub-viewport panels keep the translucent token paint. The sweep targets
    // structure, not hashed class names, so it survives app rebuilds.
    (config.clearStructural === false ? '' : 'html.' + marker + ' body{background-color:transparent !important;background-image:none !important}'),
    '.' + marker + '-clear{background-color:transparent !important;background-image:none !important}',
    (config.scrim === false ? '' :
      '.' + marker + '-scrim{position:fixed;inset:0;z-index:-1;pointer-events:none;background:#ffffff' + scrimHx + '}' +
      'html:has(body[data-ds-dark-theme]) .' + marker + '-scrim{background:#151517' + scrimHx + '}'),
    '.' + marker + '-video{position:fixed;inset:-' + bleed + 'px;width:calc(100% + ' + bleed * 2 + 'px);height:calc(100% + ' + bleed * 2 + 'px);' +
      'object-fit:cover;z-index:-2;display:block;pointer-events:none;border:0;' +
      'opacity:' + opacity +
      // A non-`none` filter makes a stacking context, so only ask for one.
      (blur > 0 ? ';filter:blur(' + blur + 'px)' : '') + '}',
    ':root{--' + marker + '-blur:' + glass + 'px}',
  ]
  if (glass > 0) {
    // saturate(150%) rides the app's own menu-glass recipe so the frosting
    // matches what menus already look like over the same backdrop.
    rows.push('.' + marker + '-glass{backdrop-filter:blur(var(--' + marker + '-blur)) saturate(150%);' +
      '-webkit-backdrop-filter:blur(var(--' + marker + '-blur)) saturate(150%);' +
      'box-shadow:inset 0 1px 0 var(--' + marker + '-rim),inset 0 0 0 1px var(--' + marker + '-hair);' +
      'background-image:linear-gradient(180deg,var(--' + marker + '-sheen),transparent 42%)}')
  }
  rows.push(block('body', LIGHT))
  rows.push(block('body[data-ds-dark-theme]', DARK))
  return rows.join('')
}

/**
 * The script row: mount the video, then drive everything from the live config.
 *
 * Also pure of outer scope: it is stringified with `.toString()` and invoked
 * with (configRoute, marker, videoRoute, buildStyle). Runs while <head> is
 * still parsing, so the first frame is up before the shell paints — same
 * reason boot-splash plugins inject here rather than from a client module.
 * Autoplay with `muted` is allowed by policy, but a suspended background tab
 * is not, so `play()` is retried on the first interaction/focus.
 *
 * @param configRoute - same-origin config endpoint.
 * @param marker - html class marker.
 * @param videoRoute - same-origin video endpoint.
 * @param buildStyle - the shared style builder, passed in as a value.
 */
function clientLive(configRoute, marker, videoRoute, buildStyle, diagRoute) {
  var root = document.documentElement
  root.classList.add(marker)
  var videoClass = marker + '-video'
  var glassClass = marker + '-glass'
  var clearClass = marker + '-clear'
  var scrimClass = marker + '-scrim'

  function mount() {
    try {
      if (root.querySelector('.' + videoClass)) return
      var v = document.createElement('video')
      v.className = videoClass
      v.setAttribute('aria-hidden', 'true')
      v.muted = true
      v.defaultMuted = true
      v.loop = true
      v.autoplay = true
      v.playsInline = true
      v.preload = 'auto'
      v.src = videoRoute
      var play = function () { var p = v.play(); if (p && p.catch) p.catch(function () {}) }
      play()
      document.addEventListener('pointerdown', play, { once: true })
      document.addEventListener('keydown', play, { once: true })
      window.addEventListener('focus', play)
      root.appendChild(v)
      // The baked style already describes the scrim; create it now so the
      // first paint matches, applyLive only has to sync it against config.
      if (!root.querySelector('.' + scrimClass)) {
        var sc = document.createElement('div')
        sc.className = scrimClass
        root.appendChild(sc)
      }
      if (!root.querySelector('.' + scrimClass)) {
        var sc = document.createElement('div')
        sc.className = scrimClass
        root.appendChild(sc)
      }
    } catch (error) {}
  }
  mount()

  function whenBody(fn) {
    if (document.body) fn()
    else document.addEventListener('DOMContentLoaded', fn)
  }

  /** Parse alpha out of `rgb(r g b / a)` or legacy `rgba(r, g, b, a)`. */
  function alphaOf(bg) {
    var slash = bg.indexOf('/')
    if (slash >= 0) { var a = parseFloat(bg.slice(slash + 1)); return Number.isFinite(a) ? a : 1 }
    var parts = bg.split(',')
    if (parts.length !== 4) return 1
    var al = parseFloat(parts[3])
    return Number.isFinite(al) ? al : 1
  }

  var current = { glass: 0, clearStructural: true }

  /** Full-viewport opaque sheets would bury the video; make them fully clear.
   *  Token overrides alone cannot do this: body and the shell frames all paint
   *  with the SAME alias, so their translucency would stack multiplicatively.
   *  Structural means structure, not hashed class names — it survives rebuilds. */
  function sweepClear() {
    try {
      if (!document.body) return
      if (current.clearStructural === false) {
        var stale = document.querySelectorAll('.' + clearClass)
        for (var s = 0; s < stale.length; s++) stale[s].classList.remove(clearClass)
        return
      }
      var vw = window.innerWidth
      var vh = window.innerHeight
      var list = document.body.querySelectorAll('div,aside,section,main')
      for (var i = 0; i < list.length; i++) {
        var el = list[i]
        if (el.classList.contains(clearClass)) continue
        var r = el.getBoundingClientRect()
        // Either dimension counts: the app nests frame × full-height columns,
        // and one translucent layer left on each multiplies with the others
        // until the video washes out — exactly what v0.2.1 did. Smaller
        // elements are real panels; they keep their (single) glassy sheet.
        if (r.width < vw * 0.95 && r.height < vh * 0.95) continue
        var cs = getComputedStyle(el)
        if (cs.backdropFilter && cs.backdropFilter !== 'none') continue
        if (alphaOf(cs.backgroundColor) < 0.02) continue // paints nothing anyway
        el.classList.add(clearClass)
      }
    } catch (error) {}
  }

  function tagGlass() {
    try {
      if (current.glass <= 0 || !document.body) return
      var list = document.body.querySelectorAll('div,aside,section,main')
      for (var i = 0; i < list.length; i++) {
        var el = list[i]
        if (el.classList.contains(glassClass)) continue
        var r = el.getBoundingClientRect()
        // Frosted glass is for panels; chips, rows and tooltips stay crisp.
        if (r.width < 160 || r.height < 90) continue
        var cs = getComputedStyle(el)
        // Menus/masks already frosted natively — double-filtering would fight.
        if (cs.backdropFilter && cs.backdropFilter !== 'none') continue
        // Only surfaces this plugin made translucent (alpha < 1).
        var a = alphaOf(cs.backgroundColor)
        if (a >= 0.999 || a <= 0.01) continue
        var p = el.parentElement
        if (p && p.closest('.' + glassClass)) continue
        el.classList.add(glassClass)
      }
    } catch (error) {}
  }

  var timer = 0
  function scheduleTag() {
    if (timer) return
    timer = setTimeout(function () {
      timer = 0
      var pass = function () { tagGlass(); sweepClear() }
      if (window.requestIdleCallback) requestIdleCallback(pass, { timeout: 2000 })
      else setTimeout(pass, 120)
    }, 80)
  }

  /** Keep exactly one scrim element mounted between the video and the app. */
  function ensureScrim(on) {
    try {
      var sc = root.querySelector('.' + scrimClass)
      if (on && !sc) {
        sc = document.createElement('div')
        sc.className = scrimClass
        root.appendChild(sc)
      } else if (!on && sc) {
        sc.remove()
      }
    } catch (error) {}
  }

  function applyLive(cfg) {
    try {
      if (!cfg || cfg.enabled === false) {
        // Baked style may still be the enabled one from mount time; a later
        // <style> with solid tokens and no marker wins over it.
        root.classList.remove(marker)
        var old = root.querySelector('.' + videoClass)
        if (old) old.remove()
        var frost = document.querySelectorAll('.' + glassClass + ',.' + clearClass)
        for (var i = 0; i < frost.length; i++) frost[i].classList.remove(glassClass, clearClass)
        cfg = { enabled: false, opacity: 1, blur: 0, surfaceAlpha: 1, sidebarAlpha: 1, glass: 0, clearStructural: false, scrim: false }
      }
      current = cfg
      ensureScrim(cfg.scrim !== false)
      var style = document.getElementById(marker + '-live')
      if (!style) {
        style = document.createElement('style')
        style.id = marker + '-live'
        document.head.appendChild(style)
      }
      // The live <style> is the last word on the page: the builder's output
      // plus the maintainer's hot-tuning overlay from ~/.dsh/ui-video-background/
      // style.css (carried as cfg.extraCss) — equal specificity, later wins.
      style.textContent = buildStyle(cfg, marker) + (typeof cfg.extraCss === 'string' ? cfg.extraCss : '')
      scheduleTag()
    } catch (error) {}
  }

  /** One DOM snapshot per load, POSTed to the local host so the plugin author
   *  can read `~/.dsh/ui-video-background/diag.json` and see exactly what
   *  paints over what. Nothing leaves the machine; the route never reads it. */
  var diagSent = false
  function diag() {
    if (diagSent) return
    diagSent = true
    try {
      var out = { page: location.href, ts: Date.now(), marker: root.classList.contains(marker), video: null, points: [] }
      var vv = root.querySelector('.' + videoClass)
      if (vv) out.video = { ready: vv.readyState, paused: vv.paused, w: vv.videoWidth, h: vv.videoHeight, code: vv.error ? vv.error.code : 0 }
      out.scrim = !!root.querySelector('.' + scrimClass)
      var probe = [[0.08, 0.5], [0.78, 0.5], [0.5, 0.92], [0.5, 0.25]]
      for (var i = 0; i < probe.length; i++) {
        var x = Math.round(window.innerWidth * probe[i][0])
        var y = Math.round(window.innerHeight * probe[i][1])
        var chain = []
        var els = document.elementsFromPoint ? document.elementsFromPoint(x, y) : []
        for (var j = 0; j < els.length && chain.length < 20; j++) {
          var cs = getComputedStyle(els[j])
          chain.push({
            el: els[j].tagName + '.' + String(els[j].className || '').slice(0, 48),
            bg: cs.backgroundColor, a: alphaOf(cs.backgroundColor),
            z: cs.zIndex, pos: cs.position, bf: cs.backdropFilter !== 'none',
          })
        }
        out.points.push({ x: x, y: y, chain: chain })
      }
      fetch(diagRoute, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) }).catch(function () {})
    } catch (error) {}
  }

  fetch(configRoute)
    .then(function (r) { return r.json() })
    .then(applyLive)
    .catch(function () {})

  whenBody(function () {
    scheduleTag()
    setTimeout(diag, 2500)
    setTimeout(sweepClear, 1200)
    try {
      new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var nodes = records[i].addedNodes
          for (var j = 0; j < nodes.length; j++) {
            // Any DOM churn may have brought a new panel; tagGlass debounces.
            if (nodes[j].nodeType === 1) { scheduleTag(); return }
          }
        }
      }).observe(document.body, { childList: true, subtree: true })
    } catch (error) {}
  })
}

function dshHome() {
  return process.env.DSH_HOME === undefined || process.env.DSH_HOME === '' ? join(homedir(), '.dsh') : process.env.DSH_HOME
}

function configPath() {
  return join(dshHome(), 'ui-video-background', 'config.json')
}

/** Read the config, seeding the file once so the user has something to edit. */
function readConfig() {
  const path = configPath()
  try {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + '\n', { flag: 'wx' })
    }
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
    return {
      enabled: raw.enabled !== false,
      video: typeof raw.video === 'string' && raw.video !== '' ? raw.video : null,
      opacity: Number.isFinite(raw.opacity) ? clamp(raw.opacity, 0, 1) : DEFAULTS.opacity,
      blur: Number.isFinite(raw.blur) ? clamp(raw.blur, 0, 12) : DEFAULTS.blur,
      surfaceAlpha: Number.isFinite(raw.surfaceAlpha) ? clamp(raw.surfaceAlpha, 0.15, 1) : DEFAULTS.surfaceAlpha,
      sidebarAlpha: Number.isFinite(raw.sidebarAlpha) ? clamp(raw.sidebarAlpha, 0.15, 1) : DEFAULTS.sidebarAlpha,
      glass: Number.isFinite(raw.glass) ? clamp(raw.glass, 0, 48) : DEFAULTS.glass,
      clearStructural: raw.clearStructural !== false,
      scrim: raw.scrim !== false,
    }
  } catch (error) {
    // A broken config must not take the feature down, and must not mute the UI.
    return { ...DEFAULTS }
  }
}

/** The file actually being served: configured path, else the bundled asset. */
function resolveVideo(config) {
  const candidate = config.video === null ? BUNDLED_VIDEO : config.video
  try {
    return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null
  } catch (error) {
    return null
  }
}

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
}

/**
 * GET the effective config: what the row decided, and which file it found.
 *
 * This is also what the page fetches at load, so config edits apply on the
 * next refresh without restarting the host (the module code itself, however,
 * is cached for the process lifetime).
 */
function configHandler(req, res) {
  const config = readConfig()
  // Hot-tuning channel: whatever the maintainer writes into
  // `$DSH_HOME/ui-video-background/style.css` rides along the config and the
  // page appends it to the live <style> — CSS tuning needs a refresh, not a
  // restart (JS in this module still does, the process caches it).
  let extraCss = null
  try {
    const p = join(dshHome(), 'ui-video-background', 'style.css')
    if (existsSync(p)) {
      const text = readFileSync(p, 'utf8')
      if (text.length <= 262144) extraCss = text
    }
  } catch (error) {}
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({
    ...config,
    configFile: configPath(),
    bundledVideo: BUNDLED_VIDEO,
    serving: resolveVideo(config),
    route: VIDEO_ROUTE,
    extraCss,
  }))
}

/**
 * POST a one-shot DOM snapshot from the page; stored locally for debugging.
 *
 * Capped and never echoed: this exists so "I cannot see the background" has an
 * answer that does not need a screenshot from the user. It stays under
 * `$DSH_HOME/ui-video-background/diag.json`.
 */
function diagHandler(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: 'method-not-allowed' }))
    return
  }
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > 262144) {
      res.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('error', () => res.destroy())
  req.on('end', () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const dir = join(dshHome(), 'ui-video-background')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'diag.json'), JSON.stringify({ receivedAt: new Date().toISOString(), payload }, null, 2) + '\n')
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'bad-json' }))
    }
  })
}

/**
 * GET (or HEAD) the video, honouring Range.
 *
 * `no-cache` rather than the immutable long-maxage the client bundles use: this
 * file is the user's, it can be swapped, and re-fetching a short clip per load
 * is not worth a stale-background bug.
 */
function videoHandler(req, res) {
  const config = readConfig()
  const file = resolveVideo(config)
  if (file === null) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: 'video-not-found', tried: config.video ?? BUNDLED_VIDEO }))
    return
  }
  let stat
  try {
    stat = statSync(file)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: String(error) }))
    return
  }
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const base = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    'last-modified': stat.mtime.toUTCString(),
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (match !== null && (match[1] !== '' || match[2] !== '')) {
    let start = match[1] === '' ? stat.size - Number(match[2]) : Number(match[1])
    let end = match[1] === '' || match[2] === '' ? stat.size - 1 : Number(match[2])
    if (Number.isNaN(start) || start < 0 || start >= stat.size || end < start || end >= stat.size) {
      res.writeHead(416, { ...base, 'content-range': `bytes */${String(stat.size)}` })
      res.end()
      return
    }
    end = Math.min(end, start + 16 * 1024 * 1024 - 1)
    res.writeHead(206, {
      ...base,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${String(start)}-${String(end)}/${String(stat.size)}`,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
    return
  }
  res.writeHead(200, { ...base, 'content-length': String(stat.size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file).on('error', () => res.destroy()).pipe(res)
}

/** The script row text: invoke the pure client with the pure style builder. */
function buildScript() {
  return (
    '(' + clientLive.toString() + ')(' +
    JSON.stringify(CONFIG_ROUTE) + ',' +
    JSON.stringify(MARKER) + ',' +
    JSON.stringify(VIDEO_ROUTE) + ',' +
    '(' + buildStyle.toString() + '),' +
    JSON.stringify(DIAG_ROUTE) + ')'
  )
}

/**
 * Contribute the background to every index response.
 *
 * `webserver/index-inject` is a plain composition event the Web carrier renders
 * into index.html after <head> opens and the Desktop carrier applies page-side,
 * so no service is injected for the background itself. The routes come from an
 * optional injection: a profile without an HTTP carrier still gets nothing
 * injected (there is nothing to point the video at), which is the safe outcome.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.on('webserver/index-inject', (table) => {
    const config = readConfig()
    if (!config.enabled || resolveVideo(config) === null) return
    // Baked from mount-time config so the FIRST paint is already right; the
    // script overwrites it with the live config moments later.
    table.push({ kind: 'style', text: buildStyle(config, MARKER) })
    table.push({ kind: 'script', placement: 'head', text: buildScript() })
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: VIDEO_ROUTE, handler: videoHandler }),
      `ui-video-bg: GET ${VIDEO_ROUTE}`,
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: CONFIG_ROUTE, handler: configHandler }),
      `ui-video-bg: GET ${CONFIG_ROUTE}`,
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: DIAG_ROUTE, handler: diagHandler }),
      `ui-video-bg: POST ${DIAG_ROUTE}`,
    )
  })
}
