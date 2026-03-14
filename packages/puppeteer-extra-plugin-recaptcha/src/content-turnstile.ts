import * as types from './types'

export const ContentScriptDefaultOpts: types.ContentScriptOpts = {
  visualFeedback: true
}

export const ContentScriptDefaultData: types.ContentScriptData = {
  solutions: []
}

/**
 * Content script for Cloudflare Turnstile captcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 *
 * Race Condition Handling:
 * - Verifies navigation ID before applying solutions
 * - Checks fingerprint data to ensure solution matches current captcha
 * - Discards solutions if page has navigated since detection
 */
export class TurnstileContentScript {
  private opts: types.ContentScriptOpts
  private data: types.ContentScriptData

  private baseUrl = 'challenges.cloudflare.com'

  constructor(
    opts = ContentScriptDefaultOpts,
    data = ContentScriptDefaultData
  ) {
    // Workaround for https://github.com/esbuild-kit/tsx/issues/113
    if (typeof globalThis.__name === 'undefined') {
      globalThis.__defProp = Object.defineProperty
      globalThis.__name = (target, value) =>
        globalThis.__defProp(target, 'name', { value, configurable: true })
    }

    this.opts = opts
    this.data = data
  }

  private async _waitUntilDocumentReady() {
    return new Promise(function(resolve) {
      if (!document || !window) return resolve(null)
      const loadedAlready = /^loaded|^i|^c/.test(document.readyState)
      if (loadedAlready) return resolve(null)

      function onReady() {
        resolve(null)
        document.removeEventListener('DOMContentLoaded', onReady)
        window.removeEventListener('load', onReady)
      }

      document.addEventListener('DOMContentLoaded', onReady)
      window.addEventListener('load', onReady)
    })
  }

  private _paintCaptchaBusy($element: HTMLElement) {
    try {
      if (this.opts.visualFeedback) {
        $element.style.filter = `opacity(60%) hue-rotate(400deg)` // violet
      }
    } catch (error) {
      // noop
    }
    return $element
  }

  /**
   * Simple hash function for fingerprinting challenge data
   */
  private _hashString(input: string): string {
    let hash = 0
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return hash.toString(16)
  }

  /**
   * Check if two fingerprints match (for solution verification)
   */
  private _fingerprintsMatch(
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
   * Get current fingerprint for a widget from the page
   */
  private _getCurrentFingerprint(widgetId: number): types.CaptchaFingerprint | null {
    const widgets = (window as any).___turnstile_widgets || []
    const widget = widgets.find((w: types.TurnstileWidgetInfo) => w.widgetId === widgetId)

    if (!widget) {
      return null
    }

    const navigationId = (window as any).___turnstile_nav_id || widget.navigationId || ''

    return {
      navigationId,
      sitekey: widget.sitekey,
      cDataHash: widget.cDataHash || (widget.cData ? this._hashString(widget.cData) : undefined),
      chlPageDataHash: widget.chlPageDataHash || (widget.chlPageData ? this._hashString(widget.chlPageData) : undefined),
      timestamp: widget.detectedAt || Date.now(),
      widgetId: widget.widgetId
    }
  }

  /**
   * Get intercepted widgets from window.___turnstile_widgets
   * These are widgets captured by the interceptor script when turnstile.render() was called
   */
  private _getInterceptedWidgets(): types.CaptchaInfo[] {
    const widgets = (window as any).___turnstile_widgets || []
    const navigationId = (window as any).___turnstile_nav_id || ''

    return widgets.map((w: types.TurnstileWidgetInfo) => {
      // Create fingerprint for this captcha
      const fingerprint: types.CaptchaFingerprint = {
        navigationId: w.navigationId || navigationId,
        sitekey: w.sitekey,
        cDataHash: w.cDataHash || (w.cData ? this._hashString(w.cData) : undefined),
        chlPageDataHash: w.chlPageDataHash || (w.chlPageData ? this._hashString(w.chlPageData) : undefined),
        timestamp: w.detectedAt || Date.now(),
        widgetId: w.widgetId
      }

      return {
        _vendor: 'turnstile' as const,
        url: document.location.href,
        id: `turnstile-${w.widgetId}`,
        widgetId: w.widgetId,
        sitekey: w.sitekey,
        action: w.action || undefined,
        callback: w.callback || undefined,
        // Turnstile-specific fields for 2captcha API
        // cData maps to 'data' parameter in 2captcha API
        cData: w.cData || undefined,
        // chlPageData maps to 'pagedata' parameter in 2captcha API
        chlPageData: w.chlPageData || undefined,
        // Store additional Turnstile-specific fields for solution entry
        display: {
          size: undefined,
          theme: undefined
        },
        // Include fingerprint for race condition detection
        fingerprint
      }
    })
  }

  /** Find Turnstile iframes */
  private _findTurnstileIframes() {
    const nodeList = document.querySelectorAll<HTMLIFrameElement>(
      `iframe[src*='${this.baseUrl}']`
    )
    return Array.from(nodeList)
  }

  /** Find Turnstile div containers */
  private _findTurnstileDivs() {
    const nodeList = document.querySelectorAll<HTMLDivElement>(
      'div.cf-turnstile, div[data-sitekey]'
    )
    return Array.from(nodeList)
  }

  /** Extract sitekey from iframe src or div data attribute */
  private _extractSitekeyFromIframe(iframe: HTMLIFrameElement): string | null {
    try {
      const src = iframe.src
      const url = new URL(src)
      return url.searchParams.get('sitekey')
    } catch {
      return null
    }
  }

  private _extractInfoFromElements(
    iframes: HTMLIFrameElement[],
    divs: HTMLDivElement[]
  ) {
    const results: types.CaptchaInfo[] = []
    const sitekeys = new Set<string>()

    // Process iframes
    for (const iframe of iframes) {
      const sitekey = this._extractSitekeyFromIframe(iframe)
      if (sitekey && !sitekeys.has(sitekey)) {
        sitekeys.add(sitekey)
        results.push({
          _vendor: 'turnstile',
          url: document.location.href,
          sitekey,
          id: sitekey
        })
      }
    }

    // Process divs
    for (const div of divs) {
      const sitekey = div.getAttribute('data-sitekey')
      if (sitekey && !sitekeys.has(sitekey)) {
        sitekeys.add(sitekey)
        results.push({
          _vendor: 'turnstile',
          url: document.location.href,
          sitekey,
          id: sitekey
        })
      }
    }

    return results
  }

  public async findRecaptchas() {
    const result = {
      captchas: [] as types.CaptchaInfo[],
      error: null as null | Error
    }
    try {
      await this._waitUntilDocumentReady()

      // First check for intercepted widgets (more complete data)
      const interceptedWidgets = this._getInterceptedWidgets()

      if (interceptedWidgets.length > 0) {
        result.captchas = interceptedWidgets

        // Paint visual feedback on found container elements
        for (const widget of interceptedWidgets) {
          const widgetInfo = (window as any).___turnstile_widgets?.find(
            (w: types.TurnstileWidgetInfo) =>
              `turnstile-${w.widgetId}` === widget.id
          )

          const container = document.getElementById(widgetInfo?.inputId)
          if (container) {
            this._paintCaptchaBusy(container)
          }
        }

        return result
      }

      // Fall back to DOM-based detection if no intercepted widgets
      const iframes = this._findTurnstileIframes()
      const divs = this._findTurnstileDivs()

      if (!iframes.length && !divs.length) {
        return result
      }

      result.captchas = this._extractInfoFromElements(iframes, divs)

      // Paint visual feedback on found elements
      iframes.forEach(el => this._paintCaptchaBusy(el))
      divs.forEach(el => this._paintCaptchaBusy(el))
    } catch (error) {
      result.error = error
      return result
    }
    return result
  }

  public async enterRecaptchaSolutions() {
    const result = {
      solved: [] as types.CaptchaSolved[],
      error: null as any,
      invalidated: [] as types.CaptchaSolution[]
    }
    try {
      await this._waitUntilDocumentReady()

      const solutions = this.data.solutions
      const navigationId = this.data.navigationId

      if (!solutions || !solutions.length) {
        result.error = 'No solutions provided'
        return result
      }

      // Get current navigation ID from page context
      const currentNavId = (window as any).___turnstile_nav_id || navigationId

      for (const solution of solutions) {
        if (solution._vendor !== 'turnstile') {
          continue
        }

        if (!solution.hasSolution) {
          continue
        }

        // Get widget ID from solution
        const widgetId = solution.widgetId || (solution.id ? parseInt(solution.id.replace('turnstile-', ''), 10) : undefined)

        if (!widgetId && widgetId !== 0) {
          continue
        }

        // Race condition detection: verify fingerprint before applying solution
        const currentFingerprint = this._getCurrentFingerprint(widgetId)

        if (solution.fingerprint && currentFingerprint) {
          const fingerprintMatches = this._fingerprintsMatch(solution.fingerprint, currentFingerprint)

          if (!fingerprintMatches) {
            result.invalidated.push(solution)
            continue
          }
        } else if (navigationId && currentNavId && navigationId !== currentNavId) {
          // Fallback: check navigation ID directly if fingerprint not available
          result.invalidated.push(solution)
          continue
        }

        // Find the response input elements
        const cfResponseInput = document.querySelector<HTMLInputElement>(
          'input[name="cf-turnstile-response"]'
        )
        const cCaptchaResponseInput = document.querySelector<HTMLInputElement>(
          'input[name="c-captcha-response"]'
        )
        // Also check for reCAPTCHA compatibility mode
        const gRecaptchaResponseInput = document.querySelector<HTMLInputElement>(
          'input[name="g-recaptcha-response"]'
        )

        // Set the token value
        if (cfResponseInput && solution.text) {
          cfResponseInput.value = solution.text
        }
        if (cCaptchaResponseInput && solution.text) {
          cCaptchaResponseInput.value = solution.text
        }
        if (gRecaptchaResponseInput && solution.text) {
          gRecaptchaResponseInput.value = solution.text
        }

        // Invoke callback if available from intercepted widget
        const widgetInfo = (window as any).___turnstile_widgets?.find(
          (w: types.TurnstileWidgetInfo) => w.widgetId === widgetId
        )

        if (widgetInfo?.callback && typeof (window as any)[widgetInfo.callback] === 'function') {
          try {
            ;(window as any)[widgetInfo.callback](solution.text)
          } catch (callbackError) {
            // Callback invocation failed - silently continue
          }
        }

        // Also call global tsCallback (used by simple interceptor pattern)
        if (typeof (window as any).tsCallback === 'function') {
          try {
            (window as any).tsCallback(solution.text);
          } catch (callbackError) {
            // Global callback invocation failed - silently continue
          }
        }

        result.solved.push({
          _vendor: solution._vendor,
          id: solution.id,
          isSolved: true,
          solvedAt: new Date()
        })
      }
    } catch (error) {
      result.error = error
      return result
    }
    return result
  }
}
