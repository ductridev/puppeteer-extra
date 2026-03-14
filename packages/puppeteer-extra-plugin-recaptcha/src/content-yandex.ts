import * as types from './types'

export const ContentScriptDefaultOpts: types.ContentScriptOpts = {
  visualFeedback: true
}

export const ContentScriptDefaultData: types.ContentScriptData = {
  solutions: []
}

/**
 * Content script for Yandex Smart Captcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 */
export class YandexContentScript {
  private opts: types.ContentScriptOpts
  private data: types.ContentScriptData

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

  /** Find Yandex Smart Captcha iframes */
  private _findYandexIframes() {
    const nodeList = document.querySelectorAll<HTMLIFrameElement>(
      `iframe[src*="smartcaptcha.yandex.com"], iframe[src*="yandex.net/captcha"], iframe[src*="captcha-api.yandex.ru"]`
    )
    return Array.from(nodeList)
  }

  /** Find Yandex Smart Captcha div containers */
  private _findYandexDivs() {
    const nodeList = document.querySelectorAll<HTMLDivElement>(
      'div.smart-captcha, div.yandex-captcha, div[data-sitekey][class*="yandex"]'
    )
    return Array.from(nodeList)
  }

  /** Find Yandex Smart Captcha input elements */
  private _findYandexInputs() {
    const nodeList = document.querySelectorAll<HTMLInputElement>(
      `input[name="smart-token"], input[name="yandex-captcha-token"]`
    )
    return Array.from(nodeList)
  }

  /** Extract sitekey from iframe src */
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
    divs: HTMLDivElement[],
    inputs: HTMLInputElement[]
  ) {
    const results: types.CaptchaInfo[] = []
    const sitekeys = new Set<string>()

    // Process iframes
    for (const iframe of iframes) {
      const sitekey = this._extractSitekeyFromIframe(iframe)
      if (sitekey && !sitekeys.has(sitekey)) {
        sitekeys.add(sitekey)
        results.push({
          _vendor: 'yandex',
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
          _vendor: 'yandex',
          url: document.location.href,
          sitekey,
          id: sitekey
        })
      }
    }

    // Process inputs - try to find sitekey from parent container
    for (const input of inputs) {
      // Try to find sitekey from parent element
      const parent = input.closest('[data-sitekey]') as HTMLElement
      const sitekey = parent?.getAttribute('data-sitekey')

      if (sitekey && !sitekeys.has(sitekey)) {
        sitekeys.add(sitekey)
        results.push({
          _vendor: 'yandex',
          url: document.location.href,
          sitekey,
          id: sitekey
        })
      } else if (!sitekey) {
        // Generate a unique ID based on input if no sitekey found
        const inputId = input.id || `yandex-input-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        if (!sitekeys.has(inputId)) {
          sitekeys.add(inputId)
          results.push({
            _vendor: 'yandex',
            url: document.location.href,
            sitekey: inputId, // Use input ID as fallback
            id: inputId
          })
        }
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
      const iframes = this._findYandexIframes()
      const divs = this._findYandexDivs()
      const inputs = this._findYandexInputs()

      if (!iframes.length && !divs.length && !inputs.length) {
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
        .filter(solution => solution._vendor === 'yandex')
        .filter(solution => solution.hasSolution === true)
        .map(solution => {
          // Find the smart-token input element
          const smartTokenInput = document.querySelector<HTMLInputElement>(
            'input[name="smart-token"]'
          )
          const yandexCaptchaTokenInput = document.querySelector<HTMLInputElement>(
            'input[name="yandex-captcha-token"]'
          )

          // Set the token value
          if (smartTokenInput && solution.text) {
            smartTokenInput.value = solution.text
          }
          if (yandexCaptchaTokenInput && solution.text) {
            yandexCaptchaTokenInput.value = solution.text
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
