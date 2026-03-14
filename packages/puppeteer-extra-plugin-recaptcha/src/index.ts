import { PuppeteerExtraPlugin } from 'puppeteer-extra-plugin'

import { Browser, Frame, Page, CDPSession } from 'puppeteer'

import * as types from './types'

import { RecaptchaContentScript } from './content'
import { HcaptchaContentScript } from './content-hcaptcha'
import { TurnstileContentScript } from './content-turnstile'
import { GeetestContentScript } from './content-geetest'
import { GeetestV4ContentScript } from './content-geetest-v4'
import { ArkoseLabsContentScript } from './content-arkoselabs'
import { AmazonWafContentScript } from './content-amazon-waf'
import { YandexContentScript } from './content-yandex'
import { CapyContentScript } from './content-capy'
import { LeminContentScript } from './content-lemin'
import { KeyCaptchaContentScript } from './content-keycaptcha'
import { NormalContentScript } from './content-normal'
import { interceptorTurnstile } from './interceptor-turnstile'
import * as TwoCaptcha from './provider/2captcha'

/**
 * Get a CDP session for the page, works with both Puppeteer and Playwright
 */
async function getCDPSession(page: Page | Frame): Promise<CDPSession> {
  // Puppeteer has createCDPSession on the page object
  if ('createCDPSession' in page && typeof page.createCDPSession === 'function') {
    return page.createCDPSession()
  }
  // Playwright has context().newCDPSession(page)
  if ('context' in page && typeof (page as any).context === 'function') {
    const context = await (page as any).context()
    return context.newCDPSession(page)
  }
  throw new Error('Could not create CDP session: unsupported page type')
}

/**
 * Generate a unique navigation ID
 */
function generateNavigationId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Simple hash function for fingerprinting challenge data
 */
function hashString(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return hash.toString(16)
}

/**
 * Create a captcha fingerprint for race condition detection
 */
function createFingerprint(
  navigationId: string,
  widget: types.TurnstileWidgetInfo
): types.CaptchaFingerprint {
  return {
    navigationId,
    sitekey: widget.sitekey,
    cDataHash: widget.cData ? hashString(widget.cData) : undefined,
    chlPageDataHash: widget.chlPageData ? hashString(widget.chlPageData) : undefined,
    timestamp: widget.detectedAt || Date.now(),
    widgetId: widget.widgetId
  }
}

/**
 * Check if two fingerprints match (for solution verification)
 * Exported for potential use in content scripts
 */
export function fingerprintsMatch(
  solutionFp: types.CaptchaFingerprint,
  currentFp: types.CaptchaFingerprint
): boolean {
  // Navigation ID is the most critical check - page must not have refreshed
  if (solutionFp.navigationId !== currentFp.navigationId) {
    return false
  }

  // Sitekey must match
  if (solutionFp.sitekey !== currentFp.sitekey) {
    return false
  }

  // If cData hash exists in both, they must match
  if (solutionFp.cDataHash && currentFp.cDataHash) {
    if (solutionFp.cDataHash !== currentFp.cDataHash) {
      return false
    }
  }

  return true
}

/**
 * Navigation monitor for detecting page refreshes during captcha solving
 *
 * This class tracks page navigations using Puppeteer's framenavigated event
 * and provides a navigation ID that can be used to detect when a page has
 * refreshed between captcha detection and solution application.
 */
class NavigationMonitor {
  private navigationId: string
  private navigationListeners: Array<(event: types.NavigationEvent) => void> = []
  private page: Page | Frame
  private debug: debug.Debugger
  private disposed = false

  constructor(page: Page | Frame, debug: debug.Debugger) {
    this.page = page
    this.debug = debug
    this.navigationId = generateNavigationId()
    this.setupListeners()
    this.debug('NavigationMonitor initialized with ID:', this.navigationId)
  }

  private setupListeners() {
    // For Page objects, listen to framenavigated on the main frame
    if ('on' in this.page) {
      const page = this.page as Page
      page.on('framenavigated', (frame) => {
        // Only track main frame navigations (not iframe navigations)
        if (frame === page.mainFrame()) {
          this.handleNavigation(frame.url())
        }
      })
    }
  }

  private handleNavigation(url?: string) {
    if (this.disposed) return

    const oldId = this.navigationId
    this.navigationId = generateNavigationId()

    const event: types.NavigationEvent = {
      navigationId: this.navigationId,
      previousNavigationId: oldId,
      timestamp: Date.now(),
      url
    }

    this.debug('Navigation detected:', event)
    this.navigationListeners.forEach(fn => fn(event))
  }

  /**
   * Get the current navigation ID
   */
  getNavigationId(): string {
    return this.navigationId
  }

  /**
   * Check if navigation has occurred since a given ID
   */
  hasNavigatedSince(navigationId: string): boolean {
    return this.navigationId !== navigationId
  }

  /**
   * Register a callback for navigation events
   */
  onNavigation(callback: (event: types.NavigationEvent) => void) {
    this.navigationListeners.push(callback)
  }

  /**
   * Dispose the monitor and remove listeners
   */
  dispose() {
    this.disposed = true
    this.navigationListeners = []
  }
}

export const BuiltinSolutionProviders: types.SolutionProvider[] = [
  {
    id: TwoCaptcha.PROVIDER_ID,
    fn: TwoCaptcha.getSolutions
  }
]

/**
 * A puppeteer-extra plugin to automatically detect and solve reCAPTCHAs.
 * @noInheritDoc
 */
export class PuppeteerExtraPluginRecaptcha extends PuppeteerExtraPlugin {
  private contentScriptDebug: debug.Debugger
  private pagesWithDebugBinding: WeakSet<object> = new WeakSet()

  constructor(opts: Partial<types.PluginOptions>) {
    super(opts)
    this.debug('Initialized', this.opts)

    this.contentScriptDebug = this.debug.extend('cs')
  }

  get name() {
    return 'recaptcha'
  }

  get defaults(): types.PluginOptions {
    return {
      visualFeedback: true,
      throwOnError: false,
      solveInViewportOnly: false,
      solveScoreBased: false,
      solveInactiveChallenges: false
    }
  }

  get opts(): types.PluginOptions {
    return super.opts as any
  }

  get contentScriptOpts(): types.ContentScriptOpts {
    const { visualFeedback } = this.opts
    return {
      visualFeedback,
      debugBinding: this.contentScriptDebug.enabled
        ? this.debugBindingName
        : undefined
    }
  }

  /** An optional global window object we use for contentscript debug logging */
  private debugBindingName = '___pepr_cs'

  private _generateContentScript(
    vendor: types.CaptchaVendor,
    fn: 'findRecaptchas' | 'enterRecaptchaSolutions',
    data?: any
  ) {
    this.debug('_generateContentScript', vendor, fn, data)
    let scriptSource = RecaptchaContentScript.toString()
    let scriptName = 'RecaptchaContentScript'
    if (vendor === 'hcaptcha') {
      scriptSource = HcaptchaContentScript.toString()
      scriptName = 'HcaptchaContentScript'
    }
    if (vendor === 'turnstile') {
      scriptSource = TurnstileContentScript.toString()
      scriptName = 'TurnstileContentScript'
    }
    if (vendor === 'geetest') {
      scriptSource = GeetestContentScript.toString()
      scriptName = 'GeetestContentScript'
    }
    if (vendor === 'geetest_v4') {
      scriptSource = GeetestV4ContentScript.toString()
      scriptName = 'GeetestV4ContentScript'
    }
    if (vendor === 'arkoselabs') {
      scriptSource = ArkoseLabsContentScript.toString()
      scriptName = 'ArkoseLabsContentScript'
    }
    if (vendor === 'amazon_waf') {
      scriptSource = AmazonWafContentScript.toString()
      scriptName = 'AmazonWafContentScript'
    }
    if (vendor === 'yandex') {
      scriptSource = YandexContentScript.toString()
      scriptName = 'YandexContentScript'
    }
    if (vendor === 'capy') {
      scriptSource = CapyContentScript.toString()
      scriptName = 'CapyContentScript'
    }
    if (vendor === 'lemin') {
      scriptSource = LeminContentScript.toString()
      scriptName = 'LeminContentScript'
    }
    if (vendor === 'keycaptcha') {
      scriptSource = KeyCaptchaContentScript.toString()
      scriptName = 'KeyCaptchaContentScript'
    }
    if (vendor === 'normal') {
      scriptSource = NormalContentScript.toString()
      scriptName = 'NormalContentScript'
    }
    // Some bundlers transform classes to anonymous classes that are assigned to
    // vars (e.g. esbuild). In such cases, `unexpected token '{'` errors are thrown
    // once the script is executed. Let's bring class name back to script in such
    // cases!
    scriptSource = scriptSource.replace(/class \{/, `class ${scriptName} {`)
    return `(async() => {
      const DATA = ${JSON.stringify(data || null)}
      const OPTS = ${JSON.stringify(this.contentScriptOpts)}

      ${scriptSource}
      const script = new ${scriptName}(OPTS, DATA)
      return script.${fn}()
    })()`
  }

  /** Based on the user defined options we may want to filter out certain captchas (inactive, etc) */
  private _filterRecaptchas(recaptchas: types.CaptchaInfo[] = []) {
    const results = recaptchas.map((c: types.FilteredCaptcha) => {
      if (
        c._type === 'invisible' &&
        !c.hasActiveChallengePopup &&
        !this.opts.solveInactiveChallenges
      ) {
        c.filtered = true
        c.filteredReason = 'solveInactiveChallenges'
      }
      if (c._type === 'score' && !this.opts.solveScoreBased) {
        c.filtered = true
        c.filteredReason = 'solveScoreBased'
      }
      if (
        c._type === 'checkbox' &&
        !c.isInViewport &&
        this.opts.solveInViewportOnly
      ) {
        c.filtered = true
        c.filteredReason = 'solveInViewportOnly'
      }
      if (c.filtered) {
        this.debug('Filtered out captcha based on provided options', {
          id: c.id,
          reason: c.filteredReason,
          captcha: c
        })
      }
      return c
    })
    return {
      captchas: results.filter(c => !c.filtered) as types.CaptchaInfo[],
      filtered: results.filter(c => c.filtered)
    }
  }

  async findRecaptchas(page: Page | Frame) {
    this.debug('findRecaptchas')
    // As this might be called very early while recaptcha is still loading
    // we add some extra waiting logic for developer convenience.
    const hasRecaptchaScriptTag = await page.$(
      `script[src*="/recaptcha/api.js"], script[src*="/recaptcha/enterprise.js"]`
    )
    this.debug('hasRecaptchaScriptTag', !!hasRecaptchaScriptTag)
    if (hasRecaptchaScriptTag) {
      this.debug('waitForRecaptchaClient - start', new Date())
      await page
        .waitForFunction(
          `
        (function() {
          return Object.keys((window.___grecaptcha_cfg || {}).clients || {}).length
        })()
      `,
          { polling: 200, timeout: 10 * 1000 }
        )
        .catch(this.debug)
      this.debug('waitForRecaptchaClient - end', new Date()) // used as timer
    }
    const hasHcaptchaScriptTag = await page.$(
      `script[src*="hcaptcha.com/1/api.js"]`
    )
    this.debug('hasHcaptchaScriptTag', !!hasHcaptchaScriptTag)
    if (hasHcaptchaScriptTag) {
      this.debug('wait:hasHcaptchaScriptTag - start', new Date())
      await page.waitForFunction(
        `
        (function() {
          return window.hcaptcha
        })()
      `,
        { polling: 200, timeout: 10 * 1000 }
      )
      this.debug('wait:hasHcaptchaScriptTag - end', new Date()) // used as timer
    }
    const hasTurnstileScriptTag = await page.$(
      `script[src*="challenges.cloudflare.com/turnstile"]`
    )
    this.debug('hasTurnstileScriptTag', !!hasTurnstileScriptTag)
    if (hasTurnstileScriptTag) {
      this.debug('wait:hasTurnstileScriptTag - start', new Date())
      await page.waitForFunction(
        `
        (function() {
          return window.turnstile
        })()
      `,
        { polling: 200, timeout: 10 * 1000 }
      )
      this.debug('wait:hasTurnstileScriptTag - end', new Date()) // used as timer
    }
    const hasGeetestV4ScriptTag = await page.$(
      `script[src*="geetest.com"], script[src*="geetest.v4"], script[src*="gcaptcha4.geetest.com"]`
    )
    this.debug('hasGeetestV4ScriptTag', !!hasGeetestV4ScriptTag)
    if (hasGeetestV4ScriptTag) {
      this.debug('wait:hasGeetestV4ScriptTag - start', new Date())
      await page.waitForFunction(
        `
        (function() {
          return window.Geetest4
        })()
      `,
        { polling: 200, timeout: 10 * 1000 }
      )
      this.debug('wait:hasGeetestV4ScriptTag - end', new Date()) // used as timer
    }
    const hasGeetestScriptTag = await page.$(
      `script[src*="api.geetest.com"], script[src*="geetest.com"]`
    )
    this.debug('hasGeetestScriptTag', !!hasGeetestScriptTag)
    if (hasGeetestScriptTag) {
      this.debug('wait:hasGeetestScriptTag - start', new Date())
      await page.waitForFunction(
        `
        (function() {
          return window.Geetest
        })()
      `,
        { polling: 200, timeout: 10 * 1000 }
      )
      this.debug('wait:hasGeetestScriptTag - end', new Date()) // used as timer
    }

    const hasArkoseLabsScriptTag = await page.$(
      `script[src*="funcaptcha.com"], script[src*="arkoselabs.com"], script[src*="client-api.arkoselabs.com"]`
    )
    this.debug('hasArkoseLabsScriptTag', !!hasArkoseLabsScriptTag)

    const hasAmazonWafScriptTag = await page.$(
      `script[src*="captcha-api.amazon.com"], script[src*="aws.amazon.com/captcha"]`
    )
    this.debug('hasAmazonWafScriptTag', !!hasAmazonWafScriptTag)

    const hasYandexScriptTag = await page.$(
      `script[src*="smartcaptcha.yandex.com"], script[src*="yandex.net/captcha"], script[src*="captcha-api.yandex.ru"]`
    )
    this.debug('hasYandexScriptTag', !!hasYandexScriptTag)

    const hasLeminScriptTag = await page.$(
      `script[src*="lemin.com"], script[src*="lemin.now"], script[src*="captcha/v1/cropped"]`
    )
    this.debug('hasLeminScriptTag', !!hasLeminScriptTag)
    if (hasLeminScriptTag) {
      this.debug('wait:hasLeminScriptTag - start', new Date())
      await page.waitForFunction(
        `
        (function() {
          return window.leminCroppedCaptcha
        })()
      `,
        { polling: 200, timeout: 10 * 1000 }
      )
      this.debug('wait:hasLeminScriptTag - end', new Date()) // used as timer
    }

    const hasKeyCaptchaScriptTag = await page.$(
      `script[src*="keycaptcha.com"], script[src*="backs.keycaptcha.com"]`
    )
    this.debug('hasKeyCaptchaScriptTag', !!hasKeyCaptchaScriptTag)

    const onDebugBindingCalled = (message: string, data: any) => {
      this.contentScriptDebug(message, data)
    }

    if (this.contentScriptDebug.enabled) {
      if ('exposeFunction' in page && !this.pagesWithDebugBinding.has(page)) {
        await page.exposeFunction(this.debugBindingName, onDebugBindingCalled)
        this.pagesWithDebugBinding.add(page)
      }
    }
    // Even without a recaptcha script tag we're trying, just in case.
    const client = await getCDPSession(page)

    async function evalMainWorld(script: string) {
      const res = await client.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true
      })

      return res.result?.value
    }

    const resultRecaptcha: types.FindRecaptchasResult = await evalMainWorld(
      this._generateContentScript('recaptcha', 'findRecaptchas')
    )

    const resultHcaptcha: types.FindRecaptchasResult = await evalMainWorld(
      this._generateContentScript('hcaptcha', 'findRecaptchas')
    )

    const resultTurnstile: types.FindRecaptchasResult = await evalMainWorld(
      this._generateContentScript('turnstile', 'findRecaptchas')
    )

    const resultGeetest: types.FindRecaptchasResult = await evalMainWorld(
      this._generateContentScript('geetest', 'findRecaptchas')
    )

    const resultGeetestV4: types.FindRecaptchasResult = await evalMainWorld(
      this._generateContentScript('geetest_v4', 'findRecaptchas')
    )

    const resultArkoseLabs: types.FindRecaptchasResult = await evalMainWorld(
      this._generateContentScript('arkoselabs', 'findRecaptchas')
    )

    const resultAmazonWaf: types.FindRecaptchasResult = await evalMainWorld(
      this._generateContentScript('amazon_waf', 'findRecaptchas')
    )

    const resultYandex: types.FindRecaptchasResult = await evalMainWorld(
      this._generateContentScript('yandex', 'findRecaptchas')
    )

    const resultLemin: types.FindRecaptchasResult = await evalMainWorld(
      this._generateContentScript('lemin', 'findRecaptchas')
    )

    const resultKeyCaptcha: types.FindRecaptchasResult = await evalMainWorld(
      this._generateContentScript('keycaptcha', 'findRecaptchas')
    )

    const resultNormal: types.FindRecaptchasResult = await evalMainWorld(
      this._generateContentScript('normal', 'findRecaptchas')
    )

    const filterResults = this._filterRecaptchas(resultRecaptcha.captchas)
    this.debug(
      `Filter results: ${filterResults.filtered.length} of ${filterResults.captchas.length} captchas filtered from results.`
    )

    const response: types.FindRecaptchasResult = {
      captchas: [...filterResults.captchas, ...resultHcaptcha.captchas, ...resultTurnstile.captchas, ...resultGeetest.captchas, ...resultGeetestV4.captchas, ...resultArkoseLabs.captchas, ...resultAmazonWaf.captchas, ...resultYandex.captchas, ...resultLemin.captchas, ...resultKeyCaptcha.captchas, ...resultNormal.captchas],
      filtered: filterResults.filtered,
      error: resultRecaptcha.error || resultHcaptcha.error || resultTurnstile.error || resultGeetest.error || resultGeetestV4.error || resultArkoseLabs.error || resultAmazonWaf.error || resultYandex.error || resultLemin.error || resultKeyCaptcha.error || resultNormal.error
    }
    this.debug('findRecaptchas', response)
    if (this.opts.throwOnError && response.error) {
      throw new Error(response.error)
    }
    return response
  }

  async getRecaptchaSolutions(
    captchas: types.CaptchaInfo[],
    provider?: types.SolutionProvider
  ) {
    this.debug('getRecaptchaSolutions', { captchaNum: captchas.length })
    provider = provider || this.opts.provider
    if (
      !provider ||
      (!provider.token && !provider.fn) ||
      (provider.token && provider.token === 'XXXXXXX' && !provider.fn)
    ) {
      throw new Error('Please provide a solution provider to the plugin.')
    }
    let fn = provider.fn
    if (!fn) {
      const builtinProvider = BuiltinSolutionProviders.find(
        p => p.id === (provider || {}).id
      )
      if (!builtinProvider || !builtinProvider.fn) {
        throw new Error(
          `Cannot find builtin provider with id '${provider.id}'.`
        )
      }
      fn = builtinProvider.fn
    }
    const response = await fn.call(
      this,
      captchas,
      provider.token,
      provider.opts || {}
    )
    response.error =
      response.error ||
      response.solutions.find((s: types.CaptchaSolution) => !!s.error)
    this.debug('getRecaptchaSolutions', response)
    if (response && response.error) {
      console.warn(
        'PuppeteerExtraPluginRecaptcha: An error occured during "getRecaptchaSolutions":',
        response.error
      )
    }
    if (this.opts.throwOnError && response.error) {
      throw new Error(response.error)
    }
    return response
  }

  async enterRecaptchaSolutions(
    page: Page | Frame,
    solutions: types.CaptchaSolution[],
    navigationId?: string
  ) {
    this.debug('enterRecaptchaSolutions', { solutions, navigationId })

    const cdp = await getCDPSession(page)

    async function evalMain(script: string) {
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: script,
        awaitPromise: true,
        returnByValue: true
      })

      return result?.value
    }

    const hasRecaptcha = !!solutions.find(s => s._vendor === 'recaptcha')

    const solvedRecaptcha: types.EnterRecaptchaSolutionsResult = hasRecaptcha
      ? await evalMain(
        this._generateContentScript('recaptcha', 'enterRecaptchaSolutions', {
          solutions
        })
      )
      : { solved: [] }

    const hasHcaptcha = !!solutions.find(s => s._vendor === 'hcaptcha')

    const solvedHcaptcha: types.EnterRecaptchaSolutionsResult = hasHcaptcha
      ? await evalMain(
        this._generateContentScript('hcaptcha', 'enterRecaptchaSolutions', {
          solutions
        })
      )
      : { solved: [] }

    const hasTurnstile = !!solutions.find(s => s._vendor === 'turnstile')

    const solvedTurnstile: types.EnterRecaptchaSolutionsResult = hasTurnstile
      ? await evalMain(
        this._generateContentScript('turnstile', 'enterRecaptchaSolutions', {
          solutions,
          navigationId
        })
      )
      : { solved: [] }

    const hasGeetest = !!solutions.find(s => s._vendor === 'geetest')

    const solvedGeetest: types.EnterRecaptchaSolutionsResult = hasGeetest
      ? await evalMain(
        this._generateContentScript('geetest', 'enterRecaptchaSolutions', {
          solutions
        })
      )
      : { solved: [] }

    const hasGeetestV4 = !!solutions.find(s => s._vendor === 'geetest_v4')

    const solvedGeetestV4: types.EnterRecaptchaSolutionsResult = hasGeetestV4
      ? await evalMain(
        this._generateContentScript('geetest_v4', 'enterRecaptchaSolutions', {
          solutions
        })
      )
      : { solved: [] }

    const hasArkoseLabs = !!solutions.find(s => s._vendor === 'arkoselabs')

    const solvedArkoseLabs: types.EnterRecaptchaSolutionsResult = hasArkoseLabs
      ? await evalMain(
        this._generateContentScript('arkoselabs', 'enterRecaptchaSolutions', {
          solutions
        })
      )
      : { solved: [] }

    const hasAmazonWaf = !!solutions.find(s => s._vendor === 'amazon_waf')

    const solvedAmazonWaf: types.EnterRecaptchaSolutionsResult = hasAmazonWaf
      ? await evalMain(
        this._generateContentScript('amazon_waf', 'enterRecaptchaSolutions', {
          solutions
        })
      )
      : { solved: [] }

    const hasYandex = !!solutions.find(s => s._vendor === 'yandex')

    const solvedYandex: types.EnterRecaptchaSolutionsResult = hasYandex
      ? await evalMain(
        this._generateContentScript('yandex', 'enterRecaptchaSolutions', {
          solutions
        })
      )
      : { solved: [] }

    const hasLemin = !!solutions.find(s => s._vendor === 'lemin')

    const solvedLemin: types.EnterRecaptchaSolutionsResult = hasLemin
      ? await evalMain(
        this._generateContentScript('lemin', 'enterRecaptchaSolutions', {
          solutions
        })
      )
      : { solved: [] }

    const hasKeyCaptcha = !!solutions.find(s => s._vendor === 'keycaptcha')

    const solvedKeyCaptcha: types.EnterRecaptchaSolutionsResult = hasKeyCaptcha
      ? await evalMain(
        this._generateContentScript('keycaptcha', 'enterRecaptchaSolutions', {
          solutions
        })
      )
      : { solved: [] }

    const hasNormal = !!solutions.find(s => s._vendor === 'normal')

    const solvedNormal: types.EnterRecaptchaSolutionsResult = hasNormal
      ? await evalMain(
        this._generateContentScript('normal', 'enterRecaptchaSolutions', {
          solutions
        })
      )
      : { solved: [] }

    const response: types.EnterRecaptchaSolutionsResult = {
      solved: [...solvedRecaptcha.solved, ...solvedHcaptcha.solved, ...solvedTurnstile.solved, ...solvedGeetest.solved, ...solvedGeetestV4.solved, ...solvedArkoseLabs.solved, ...solvedAmazonWaf.solved, ...solvedYandex.solved, ...solvedLemin.solved, ...solvedKeyCaptcha.solved, ...solvedNormal.solved],
      error: solvedRecaptcha.error || solvedHcaptcha.error || solvedTurnstile.error || solvedGeetest.error || solvedGeetestV4.error || solvedArkoseLabs.error || solvedAmazonWaf.error || solvedYandex.error || solvedLemin.error || solvedKeyCaptcha.error || solvedNormal.error
    }
    response.error = response.error || response.solved.find(s => !!s.error)
    this.debug('enterRecaptchaSolutions', response)
    if (this.opts.throwOnError && response.error) {
      throw new Error(response.error)
    }
    return response
  }

  async solveRecaptchas(
    page: Page | Frame
  ): Promise<types.SolveRecaptchasResult> {
    this.debug('solveRecaptchas')
    const response: types.SolveRecaptchasResult = {
      captchas: [],
      filtered: [],
      solutions: [],
      solved: [],
      error: null
    }

    // Create navigation monitor for race condition detection
    const navigationMonitor = new NavigationMonitor(page, this.debug)

    try {
      // If `this.opts.throwOnError` is set any of the
      // following will throw and abort execution.

      // Store navigation ID at detection time
      const detectionNavId = navigationMonitor.getNavigationId()

      // Inject navigation ID into page context for content scripts
      await this._injectNavigationId(page, detectionNavId)

      const {
        captchas,
        filtered,
        error: captchasError
      } = await this.findRecaptchas(page)
      response.captchas = captchas
      response.filtered = filtered

      if (captchas.length) {
        // Add fingerprint to captchas for Turnstile
        // Get widgets once for all captchas to avoid multiple CDP calls
        const widgets = await this._getTurnstileWidgets(page)
        const captchasWithFingerprints = captchas.map(captcha => {
          if (captcha._vendor === 'turnstile') {
            // Get the widget info to create fingerprint
            const widget = widgets.find(w => `turnstile-${w.widgetId}` === captcha.id)
            if (widget) {
              captcha.fingerprint = createFingerprint(detectionNavId, widget)
            }
          }
          return captcha
        })

        const {
          solutions,
          error: solutionsError
        } = await this.getRecaptchaSolutions(captchasWithFingerprints)
        response.solutions = solutions

        // Check for navigation before entering solutions (race condition detection)
        if (navigationMonitor.hasNavigatedSince(detectionNavId)) {
          this.debug('Page navigated during solving, solutions may be invalid')
          // Mark solutions as potentially invalid but still try to apply them
          // The content script will do additional verification
        }

        // Pass navigation ID to content script for verification
        const {
          solved,
          error: solvedError
        } = await this.enterRecaptchaSolutions(page, response.solutions, detectionNavId)
        response.solved = solved

        response.error = captchasError || solutionsError || solvedError
      }
    } catch (error) {
      response.error = error.toString()
    } finally {
      navigationMonitor.dispose()
    }
    this.debug('solveRecaptchas', response)
    if (this.opts.throwOnError && response.error) {
      throw new Error(response.error)
    }
    return response
  }

  /**
   * Inject navigation ID into page context for content scripts to access
   */
  private async _injectNavigationId(page: Page | Frame, navigationId: string) {
    try {
      const client = await getCDPSession(page)
      await client.send('Runtime.evaluate', {
        expression: `window.___turnstile_nav_id = "${navigationId}"`,
        awaitPromise: true
      })
    } catch (error) {
      this.debug('Failed to inject navigation ID:', error)
    }
  }

  /**
   * Get Turnstile widgets from page context
   */
  private async _getTurnstileWidgets(page: Page | Frame): Promise<types.TurnstileWidgetInfo[]> {
    try {
      const client = await getCDPSession(page)
      const { result } = await client.send('Runtime.evaluate', {
        expression: `window.___turnstile_widgets || []`,
        returnByValue: true
      })
      return result?.value || []
    } catch (error) {
      this.debug('Failed to get Turnstile widgets:', error)
      return []
    }
  }

  private _addCustomMethods(prop: Page | Frame) {
    prop.findRecaptchas = async () => this.findRecaptchas(prop)
    prop.getRecaptchaSolutions = async (
      captchas: types.CaptchaInfo[],
      provider?: types.SolutionProvider
    ) => this.getRecaptchaSolutions(captchas, provider)
    prop.enterRecaptchaSolutions = async (solutions: types.CaptchaSolution[]) =>
      this.enterRecaptchaSolutions(prop, solutions)
    // Add convenience methods that wraps all others
    prop.solveRecaptchas = async () => this.solveRecaptchas(prop)
  }

  async onPageCreated(page: Page) {
    this.debug('onPageCreated', page.url())

    // Inject Turnstile interceptor BEFORE any navigation occurs
    // We use evaluateOnNewDocument to run in the page's main context (not isolated world)
    // This is necessary to intercept window.turnstile.render() calls
    // Using evaluateOnNewDocument instead of addScriptTag to bypass Trusted Types CSP restrictions
    // CDP's Page.addScriptToEvaluateOnNewDocument has elevated privileges that bypass Trusted Types
    await page.evaluateOnNewDocument(interceptorTurnstile)

    // Add custom page methods
    this._addCustomMethods(page)

    // Add custom methods to potential frames as well
    page.on('frameattached', frame => {
      if (!frame) return
      this._addCustomMethods(frame)
    })
  }

  async onPageRefreshed(page: Page) {
    this.debug('onPageRefreshed', page.url())
    // Re-add custom methods to the refreshed page
    this._addCustomMethods(page)
  }

  /** Add additions to already existing pages and frames */
  async onBrowser(browser: Browser) {
    const pages = await browser.pages()
    for (const page of pages) {
      this._addCustomMethods(page)
      for (const frame of page.mainFrame().childFrames()) {
        this._addCustomMethods(frame)
      }
    }
  }
}

/** Default export, PuppeteerExtraPluginRecaptcha  */
const defaultExport = (options?: Partial<types.PluginOptions>) => {
  return new PuppeteerExtraPluginRecaptcha(options || {})
}

export default defaultExport
