import * as types from './types'

export const ContentScriptDefaultOpts: types.ContentScriptOpts = {
  visualFeedback: true
}

export const ContentScriptDefaultData: types.ContentScriptData = {
  solutions: []
}

/**
 * Content script for ArkoseLabs (FunCaptcha) captcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 */
export class ArkoseLabsContentScript {
  private opts: types.ContentScriptOpts
  private data: types.ContentScriptData

  private funcaptchaDomains = [
    'funcaptcha.com',
    'arkoselabs.com',
    'client-api.arkoselabs.com'
  ]

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

  /** Find FunCaptcha iframes */
  private _findFunCaptchaIframes() {
    const selectors = this.funcaptchaDomains.map(
      domain => `iframe[src*='${domain}']`
    )
    const nodeList = document.querySelectorAll<HTMLIFrameElement>(
      selectors.join(', ')
    )
    return Array.from(nodeList)
  }

  /** Find FunCaptcha div containers */
  private _findFunCaptchaDivs() {
    const nodeList = document.querySelectorAll<HTMLDivElement>(
      'div#FunCaptcha, div.funcaptcha, div[data-pkey]'
    )
    return Array.from(nodeList)
  }

  /** Find fc-token input elements */
  private _findFcTokenInputs() {
    const nodeList = document.querySelectorAll<HTMLInputElement>(
      'input[name="fc-token"], input[id="fc-token"]'
    )
    return Array.from(nodeList)
  }

  /** Extract public key from iframe src */
  private _extractPublicKeyFromIframe(iframe: HTMLIFrameElement): string | null {
    try {
      const src = iframe.src
      const url = new URL(src)
      // Try to get 'pk' parameter
      const pk = url.searchParams.get('pk')
      if (pk) return pk
      return null
    } catch {
      return null
    }
  }

  /** Extract public key from div data attribute */
  private _extractPublicKeyFromDiv(div: HTMLDivElement): string | null {
    return div.getAttribute('data-pkey')
  }

  /** Extract public key from fc-token input value */
  private _extractPublicKeyFromTokenInput(input: HTMLInputElement): string | null {
    try {
      const value = input.value
      if (!value) return null

      // Parse the token format: pk=xxx|surl=xxx|...
      const params: Record<string, string> = {}
      value.split('|').forEach(pair => {
        const [key, val] = pair.split('=')
        if (key && val) {
          params[key] = unescape(val)
        }
      })

      return params['pk'] || null
    } catch {
      return null
    }
  }

  /** Extract surl from fc-token input value */
  private _extractSurlFromTokenInput(input: HTMLInputElement): string | undefined {
    try {
      const value = input.value
      if (!value) return undefined

      const params: Record<string, string> = {}
      value.split('|').forEach(pair => {
        const [key, val] = pair.split('=')
        if (key && val) {
          params[key] = unescape(val)
        }
      })

      return params['surl'] || undefined
    } catch {
      return undefined
    }
  }

  /** Get public key from global FcMeta object */
  private _getPublicKeyFromGlobal(): string | null {
    try {
      const win = window as any
      if (win.FcMeta && win.FcMeta.public_key) {
        return win.FcMeta.public_key
      }
      return null
    } catch {
      return null
    }
  }

  /** Check if FunCaptcha global object exists */
  private _hasFunCaptchaGlobal(): boolean {
    const win = window as any
    return typeof win.FunCaptcha !== 'undefined'
  }

  private _extractInfoFromElements(
    iframes: HTMLIFrameElement[],
    divs: HTMLDivElement[],
    inputs: HTMLInputElement[]
  ) {
    const results: types.CaptchaInfo[] = []
    const publicKeys = new Set<string>()

    // Process iframes
    for (const iframe of iframes) {
      const publicKey = this._extractPublicKeyFromIframe(iframe)
      if (publicKey && !publicKeys.has(publicKey)) {
        publicKeys.add(publicKey)
        results.push({
          _vendor: 'arkoselabs',
          url: document.location.href,
          sitekey: publicKey, // Use sitekey for consistency with other vendors
          id: publicKey
        })
      }
    }

    // Process divs
    for (const div of divs) {
      const publicKey = this._extractPublicKeyFromDiv(div)
      if (publicKey && !publicKeys.has(publicKey)) {
        publicKeys.add(publicKey)
        results.push({
          _vendor: 'arkoselabs',
          url: document.location.href,
          sitekey: publicKey,
          id: publicKey
        })
      }
    }

    // Process fc-token inputs (these have the most complete info)
    for (const input of inputs) {
      const publicKey = this._extractPublicKeyFromTokenInput(input)
      if (publicKey && !publicKeys.has(publicKey)) {
        publicKeys.add(publicKey)
        const surl = this._extractSurlFromTokenInput(input)
        results.push({
          _vendor: 'arkoselabs',
          url: document.location.href,
          sitekey: publicKey,
          id: publicKey,
          // Store surl in the s property (reusing existing field)
          s: surl
        })
      }
    }

    // Try global object as fallback
    if (results.length === 0) {
      const globalPublicKey = this._getPublicKeyFromGlobal()
      if (globalPublicKey && !publicKeys.has(globalPublicKey)) {
        publicKeys.add(globalPublicKey)
        results.push({
          _vendor: 'arkoselabs',
          url: document.location.href,
          sitekey: globalPublicKey,
          id: globalPublicKey
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
      const iframes = this._findFunCaptchaIframes()
      const divs = this._findFunCaptchaDivs()
      const inputs = this._findFcTokenInputs()

      if (!iframes.length && !divs.length && !inputs.length && !this._hasFunCaptchaGlobal()) {
        return result
      }

      result.captchas = this._extractInfoFromElements(iframes, divs, inputs)

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
        .filter(solution => solution._vendor === 'arkoselabs')
        .filter(solution => solution.hasSolution === true)
        .map(solution => {
          // Find the fc-token input elements
          const fcTokenInput = document.querySelector<HTMLInputElement>(
            'input[name="fc-token"], input[id="fc-token"]'
          )

          // Set the token value
          if (fcTokenInput && solution.text) {
            fcTokenInput.value = solution.text

            // Trigger change events
            fcTokenInput.dispatchEvent(new Event('input', { bubbles: true }))
            fcTokenInput.dispatchEvent(new Event('change', { bubbles: true }))
          }

          // Also try to find and trigger any callback
          const win = window as any
          if (win.arkoselabs_callback_dse7f73ek && solution.text) {
            try {
              win.arkoselabs_callback_dse7f73ek(solution.text)
            } catch {
              // Ignore callback errors
            }
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
