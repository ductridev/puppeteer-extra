import * as types from './types'

export const ContentScriptDefaultOpts: types.ContentScriptOpts = {
  visualFeedback: true
}

export const ContentScriptDefaultData: types.ContentScriptData = {
  solutions: []
}

/**
 * Content script for Amazon WAF captcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 */
export class AmazonWafContentScript {
  private opts: types.ContentScriptOpts
  private data: types.ContentScriptData

  private baseUrl = 'captcha-api.amazon.com'

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

  /** Find Amazon WAF iframes */
  private _findAmazonWafIframes() {
    const nodeList = document.querySelectorAll<HTMLIFrameElement>(
      `iframe[src*='${this.baseUrl}'], iframe[src*='aws.amazon.com/captcha']`
    )
    return Array.from(nodeList)
  }

  /** Find Amazon WAF div containers */
  private _findAmazonWafDivs() {
    const nodeList = document.querySelectorAll<HTMLDivElement>(
      'div#amazon-captcha, div.amazon-waf-captcha, div[data-sitekey][class*="amazon"]'
    )
    return Array.from(nodeList)
  }

  /** Find script tags containing Amazon WAF configuration */
  private _findAmazonWafScripts() {
    const scripts = document.querySelectorAll<HTMLScriptElement>('script')
    const results: HTMLScriptElement[] = []

    Array.from(scripts).forEach(script => {
      const content = script.textContent || script.innerHTML
      if (content && content.includes('captcha-api.amazon.com')) {
        results.push(script)
      }
    })

    return results
  }

  /** Extract sitekey from element or page scripts */
  private _extractSitekey(element: HTMLElement): string | null {
    // Try data-sitekey attribute first
    const sitekey = element.getAttribute('data-sitekey')
    if (sitekey) return sitekey

    // Try to find in parent element
    const parent = element.parentElement
    if (parent) {
      const parentSitekey = parent.getAttribute('data-sitekey')
      if (parentSitekey) return parentSitekey
    }

    // Try to extract from iframe src
    if (element instanceof HTMLIFrameElement) {
      try {
        const src = element.src
        const url = new URL(src)
        const keyParam = url.searchParams.get('key')
        if (keyParam) return keyParam
      } catch {
        // noop
      }
    }

    return null
  }

  /** Extract iv from element or page scripts */
  private _extractIv(element: HTMLElement): string | undefined {
    const iv = element.getAttribute('data-iv')
    if (iv) return iv

    const parent = element.parentElement
    if (parent) {
      const parentIv = parent.getAttribute('data-iv')
      if (parentIv) return parentIv
    }

    return undefined
  }

  /** Extract context from element or page scripts */
  private _extractContext(element: HTMLElement): string | undefined {
    const context = element.getAttribute('data-context')
    if (context) return context

    const parent = element.parentElement
    if (parent) {
      const parentContext = parent.getAttribute('data-context')
      if (parentContext) return parentContext
    }

    return undefined
  }

  private _extractInfoFromElements(
    iframes: HTMLIFrameElement[],
    divs: HTMLDivElement[],
    scripts: HTMLScriptElement[]
  ) {
    const results: types.CaptchaInfo[] = []
    const sitekeys = new Set<string>()

    // Process iframes
    for (const iframe of iframes) {
      const sitekey = this._extractSitekey(iframe)
      if (sitekey && !sitekeys.has(sitekey)) {
        sitekeys.add(sitekey)
        results.push({
          _vendor: 'amazon_waf',
          url: document.location.href,
          sitekey,
          iv: this._extractIv(iframe),
          context: this._extractContext(iframe),
          id: sitekey
        })
      }
    }

    // Process divs
    for (const div of divs) {
      const sitekey = this._extractSitekey(div)
      if (sitekey && !sitekeys.has(sitekey)) {
        sitekeys.add(sitekey)
        results.push({
          _vendor: 'amazon_waf',
          url: document.location.href,
          sitekey,
          iv: this._extractIv(div),
          context: this._extractContext(div),
          id: sitekey
        })
      }
    }

    // Process scripts - try to extract configuration from script content
    for (const script of scripts) {
      const content = script.textContent || script.innerHTML
      // Try to find sitekey/key in script content
      const keyMatch = content.match(/["']key["']\s*:\s*["']([^"']+)["']/)
      if (keyMatch && keyMatch[1] && !sitekeys.has(keyMatch[1])) {
        sitekeys.add(keyMatch[1])
        // Try to find iv and context as well
        const ivMatch = content.match(/["']iv["']\s*:\s*["']([^"']+)["']/)
        const contextMatch = content.match(/["']context["']\s*:\s*["']([^"']+)["']/)

        results.push({
          _vendor: 'amazon_waf',
          url: document.location.href,
          sitekey: keyMatch[1],
          iv: ivMatch ? ivMatch[1] : undefined,
          context: contextMatch ? contextMatch[1] : undefined,
          id: keyMatch[1]
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
      const iframes = this._findAmazonWafIframes()
      const divs = this._findAmazonWafDivs()
      const scripts = this._findAmazonWafScripts()

      if (!iframes.length && !divs.length && !scripts.length) {
        return result
      }

      result.captchas = this._extractInfoFromElements(iframes, divs, scripts)

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
      error: null as any
    }
    try {
      await this._waitUntilDocumentReady()

      const solutions = this.data.solutions
      if (!solutions || !solutions.length) {
        result.error = 'No solutions provided'
        return result
      }

      result.solved = solutions
        .filter(solution => solution._vendor === 'amazon_waf')
        .filter(solution => solution.hasSolution === true)
        .map(solution => {
          // Find the captcha verification input elements
          const captchaVerificationInput = document.querySelector<HTMLInputElement>(
            'input[name="captcha-verification"]'
          )
          const amazonWafVoucherInput = document.querySelector<HTMLInputElement>(
            'input[name="amazon_waf_captcha_voucher"]'
          )
          const amazonWafExistingTokenInput = document.querySelector<HTMLInputElement>(
            'input[name="amazon_waf_existing_token"]'
          )

          // Set the token value in inputs
          if (captchaVerificationInput && solution.text) {
            captchaVerificationInput.value = solution.text
          }
          if (amazonWafVoucherInput && solution.text) {
            amazonWafVoucherInput.value = solution.text
          }
          if (amazonWafExistingTokenInput && solution.text) {
            amazonWafExistingTokenInput.value = solution.text
          }

          // Try to find or create a meta tag for captcha-verification
          let metaTag = document.querySelector<HTMLMetaElement>(
            'meta[name="captcha-verification"]'
          )
          if (!metaTag) {
            metaTag = document.createElement('meta')
            metaTag.name = 'captcha-verification'
            document.head.appendChild(metaTag)
          }
          if (solution.text) {
            metaTag.content = solution.text
          }

          // Try to set the aws-waf-captcha-verification cookie
          try {
            document.cookie = `aws-waf-captcha-verification=${solution.text}; path=/`
          } catch {
            // noop - cookie setting may fail in some contexts
          }

          // Try to trigger ChallengeScript.submitCaptcha if available
          try {
            if (typeof (window as any).ChallengeScript !== 'undefined' &&
                typeof (window as any).ChallengeScript.submitCaptcha === 'function') {
              (window as any).ChallengeScript.submitCaptcha(solution.text)
            }
          } catch {
            // noop
          }

          return {
            _vendor: solution._vendor,
            id: solution.id,
            isSolved: true,
            solvedAt: new Date()
          }
        })
    } catch (error) {
      result.error = error
      return result
    }
    return result
  }
}
