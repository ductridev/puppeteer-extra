import * as types from './types'

export const ContentScriptDefaultOpts: types.ContentScriptOpts = {
  visualFeedback: true
}

export const ContentScriptDefaultData: types.ContentScriptData = {
  solutions: []
}

/**
 * Content script for KeyCaptcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 */
export class KeyCaptchaContentScript {
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

  /** Find KeyCaptcha container divs */
  private _findKeyCaptchaContainers() {
    const nodeList = document.querySelectorAll<HTMLDivElement>(
      'div#div_for_keycaptcha, div.keycaptcha, div#keycaptcha'
    )
    return Array.from(nodeList)
  }

  /** Find KeyCaptcha iframes */
  private _findKeyCaptchaIframes() {
    const nodeList = document.querySelectorAll<HTMLIFrameElement>(
      'iframe[src*="keycaptcha.com"], iframe[src*="backs.keycaptcha.com"]'
    )
    return Array.from(nodeList)
  }

  /**
   * Extract KeyCaptcha parameters from script tags
   * KeyCaptcha uses global variables defined in script tags:
   * - s_s_c_user_id
   * - s_s_c_session_id
   * - s_s_c_web_server_sign
   * - s_s_c_web_server_sign2
   * - s_s_c_captcha_field_id (optional)
   * - s_s_c_submit_button_id (optional)
   */
  private _extractKeyCaptchaParams(): {
    userId: string | null
    sessionId: string | null
    webServerSign: string | null
    webServerSign2: string | null
    captchaFieldId: string | null
    submitButtonId: string | null
  } {
    const result = {
      userId: null as string | null,
      sessionId: null as string | null,
      webServerSign: null as string | null,
      webServerSign2: null as string | null,
      captchaFieldId: null as string | null,
      submitButtonId: null as string | null
    }

    // Check window globals first (in case scripts already executed)
    if ((window as any).s_s_c_user_id) {
      result.userId = (window as any).s_s_c_user_id
      result.sessionId = (window as any).s_s_c_session_id || null
      result.webServerSign = (window as any).s_s_c_web_server_sign || null
      result.webServerSign2 = (window as any).s_s_c_web_server_sign2 || null
      result.captchaFieldId = (window as any).s_s_c_captcha_field_id || null
      result.submitButtonId = (window as any).s_s_c_submit_button_id || null
      return result
    }

    // Parse script tags to extract variables
    const scripts = document.querySelectorAll('script')
    for (let i = 0; i < scripts.length; i++) {
      const code = scripts[i].textContent || ''
      if (code.indexOf('s_s_c_user_id') !== -1) {
        // Extract variables using regex patterns
        const userIdMatch = code.match(/var\s+s_s_c_user_id\s*=\s*['"]([^'"]+)['"]/)
        const sessionIdMatch = code.match(/var\s+s_s_c_session_id\s*=\s*['"]([^'"]+)['"]/)
        const webServerSignMatch = code.match(/var\s+s_s_c_web_server_sign\s*=\s*['"]([^'"]+)['"]/)
        const webServerSign2Match = code.match(/var\s+s_s_c_web_server_sign2\s*=\s*['"]([^'"]+)['"]/)
        const captchaFieldIdMatch = code.match(/var\s+s_s_c_captcha_field_id\s*=\s*['"]([^'"]+)['"]/)
        const submitButtonIdMatch = code.match(/var\s+s_s_c_submit_button_id\s*=\s*['"]([^'"]+)['"]/)

        if (userIdMatch) result.userId = userIdMatch[1]
        if (sessionIdMatch) result.sessionId = sessionIdMatch[1]
        if (webServerSignMatch) result.webServerSign = webServerSignMatch[1]
        if (webServerSign2Match) result.webServerSign2 = webServerSign2Match[1]
        if (captchaFieldIdMatch) result.captchaFieldId = captchaFieldIdMatch[1]
        if (submitButtonIdMatch) result.submitButtonId = submitButtonIdMatch[1]
        break
      }
    }

    return result
  }

  public async findRecaptchas() {
    const result = {
      captchas: [] as types.CaptchaInfo[],
      error: null as null | Error
    }
    try {
      await this._waitUntilDocumentReady()
      const containers = this._findKeyCaptchaContainers()
      const iframes = this._findKeyCaptchaIframes()

      if (!containers.length && !iframes.length) {
        return result
      }

      // Extract parameters from script tags
      const params = this._extractKeyCaptchaParams()

      // We need at least the required parameters
      if (!params.userId || !params.sessionId || !params.webServerSign || !params.webServerSign2) {
        return result
      }

      // Create a unique id for this captcha
      const captchaId = `keycaptcha_${params.sessionId}`

      const captchaInfo: types.CaptchaInfo = {
        _vendor: 'keycaptcha',
        url: document.location.href,
        id: captchaId,
        sitekey: params.userId, // Using sitekey field to store user_id for provider compatibility
        // Store additional params that will be used by the provider
        callback: params.captchaFieldId || undefined
      }

      // Store extra data in the captcha info for later use
      ;(captchaInfo as any).s_s_c_user_id = params.userId
      ;(captchaInfo as any).s_s_c_session_id = params.sessionId
      ;(captchaInfo as any).s_s_c_web_server_sign = params.webServerSign
      ;(captchaInfo as any).s_s_c_web_server_sign2 = params.webServerSign2
      ;(captchaInfo as any).s_s_c_captcha_field_id = params.captchaFieldId
      ;(captchaInfo as any).s_s_c_submit_button_id = params.submitButtonId

      result.captchas = [captchaInfo]

      // Paint visual feedback on found elements
      containers.forEach(el => this._paintCaptchaBusy(el))
      iframes.forEach(el => this._paintCaptchaBusy(el))
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
        .filter(solution => solution._vendor === 'keycaptcha')
        .filter(solution => solution.hasSolution === true)
        .map(solution => {
          // Get the captcha field id from the solution or try to find it
          const captchaFieldId = (solution as any).s_s_c_captcha_field_id
          let responseInput: HTMLInputElement | null = null

          // Try to find the response input by captcha field id
          if (captchaFieldId) {
            responseInput = document.querySelector<HTMLInputElement>(`#${captchaFieldId}`)
          }

          // Try alternative selectors
          if (!responseInput) {
            responseInput = document.querySelector<HTMLInputElement>('input[name="capcode"]')
          }
          if (!responseInput) {
            responseInput = document.querySelector<HTMLInputElement>('input[type="hidden"][id*="keycaptcha"]')
          }
          if (!responseInput) {
            responseInput = document.querySelector<HTMLInputElement>('input[id*="s_s_c_captcha_field"]')
          }

          // Set the token value
          if (responseInput && solution.text) {
            responseInput.value = solution.text
          }

          // Try to find and remove the KeyCaptcha container (like the reference implementation)
          const container = document.querySelector<HTMLDivElement>('#div_for_keycaptcha')
          if (container) {
            container.remove()
          }

          // Try to remove the KeyCaptcha script
          const scripts = document.querySelectorAll('script')
          for (let i = 0; i < scripts.length; i++) {
            const src = scripts[i].getAttribute('src')
            if (src && src.indexOf('backs.keycaptcha.com/swfs/cap.js') !== -1) {
              scripts[i].remove()
              break
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
