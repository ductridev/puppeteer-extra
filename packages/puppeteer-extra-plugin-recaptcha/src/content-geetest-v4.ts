import * as types from './types'

export const ContentScriptDefaultOpts: types.ContentScriptOpts = {
  visualFeedback: true
}

export const ContentScriptDefaultData: types.ContentScriptData = {
  solutions: []
}

/**
 * Content script for GeeTest V4 captcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 */
export class GeetestV4ContentScript {
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

  /** Find GeeTest V4 iframes */
  private _findGeetestV4Iframes() {
    const nodeList = document.querySelectorAll<HTMLIFrameElement>(
      `iframe[src*="geetest.com"], iframe[src*="geetest.v4"]`
    )
    return Array.from(nodeList)
  }

  /** Find GeeTest V4 containers */
  private _findGeetestV4Containers() {
    const nodeList = document.querySelectorAll<HTMLDivElement>(
      'div[data-gt], div[data-captcha-id], .geetest_captcha'
    )
    return Array.from(nodeList)
  }

  /** Check for initGeetest4 global function */
  private _hasInitGeetest4() {
    return typeof (window as any).initGeetest4 !== 'undefined'
  }

  /** Extract captchaId from iframe src */
  private _extractCaptchaIdFromIframe(iframe: HTMLIFrameElement): string | null {
    try {
      const src = iframe.src
      const url = new URL(src)
      // Try gt parameter first
      const gt = url.searchParams.get('gt')
      if (gt) return gt
      // Try captcha_id parameter
      const captchaId = url.searchParams.get('captcha_id')
      if (captchaId) return captchaId
    } catch {
      // noop
    }
    return null
  }

  /** Extract captchaId from script tags */
  private _extractCaptchaIdFromScripts(): string | null {
    try {
      const scripts = document.querySelectorAll('script')
      const scriptUrl = '//gcaptcha4.geetest.com/load'

      for (let i = 0; i < scripts.length; i++) {
        const src = scripts[i].getAttribute('src')
        if (typeof src === 'string' && src.indexOf(scriptUrl) > -1) {
          const url = new URL(src)
          const captchaId = url.searchParams.get('captcha_id')
          if (captchaId) return captchaId
        }
      }
    } catch {
      // noop
    }
    return null
  }

  /** Extract captchaId from global geetest objects */
  private _extractCaptchaIdFromGlobals(): string | null {
    try {
      const win = window as any
      // Check captchaObjV4
      if (win.captchaObjV4) {
        // Try to get captchaId from the captcha object
        if (win.captchaObjV4.captchaId) {
          return win.captchaObjV4.captchaId
        }
      }
    } catch {
      // noop
    }
    return null
  }

  private _extractInfoFromElements(
    iframes: HTMLIFrameElement[],
    containers: HTMLDivElement[]
  ) {
    const results: types.CaptchaInfo[] = []
    const captchaIds = new Set<string>()

    // Process iframes
    for (const iframe of iframes) {
      const captchaId = this._extractCaptchaIdFromIframe(iframe)
      if (captchaId && !captchaIds.has(captchaId)) {
        captchaIds.add(captchaId)
        results.push({
          _vendor: 'geetest_v4',
          url: document.location.href,
          sitekey: captchaId, // Using sitekey field to store captchaId for API compatibility
          id: captchaId
        })
      }
    }

    // Process containers
    for (const container of containers) {
      // Try data-captcha-id attribute first
      let captchaId = container.getAttribute('data-captcha-id')
      // Then try data-gt attribute
      if (!captchaId) {
        captchaId = container.getAttribute('data-gt')
      }

      if (captchaId && !captchaIds.has(captchaId)) {
        captchaIds.add(captchaId)
        results.push({
          _vendor: 'geetest_v4',
          url: document.location.href,
          sitekey: captchaId, // Using sitekey field to store captchaId for API compatibility
          id: captchaId
        })
      }
    }

    // If no captcha found but initGeetest4 exists, try to get from scripts/globals
    if (results.length === 0 && this._hasInitGeetest4()) {
      let captchaId = this._extractCaptchaIdFromScripts()
      if (!captchaId) {
        captchaId = this._extractCaptchaIdFromGlobals()
      }

      if (captchaId && !captchaIds.has(captchaId)) {
        captchaIds.add(captchaId)
        results.push({
          _vendor: 'geetest_v4',
          url: document.location.href,
          sitekey: captchaId,
          id: captchaId
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
      const iframes = this._findGeetestV4Iframes()
      const containers = this._findGeetestV4Containers()

      if (!iframes.length && !containers.length && !this._hasInitGeetest4()) {
        return result
      }

      result.captchas = this._extractInfoFromElements(iframes, containers)

      // Paint visual feedback on found elements
      iframes.forEach(el => this._paintCaptchaBusy(el))
      containers.forEach(el => this._paintCaptchaBusy(el))
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
        .filter(solution => solution._vendor === 'geetest_v4')
        .filter(solution => solution.hasSolution === true)
        .map(solution => {
          // Find the geetest response container
          const container = document.querySelector('.geetest_captcha')

          // Create or find the helper div for storing solution values
          let helper = container?.querySelector('.twocaptcha-geetest_v4-helper') as HTMLDivElement

          if (!helper && container) {
            helper = document.createElement('div')
            helper.className = 'twocaptcha-geetest_v4-helper'
            helper.innerHTML = `
              <input type="hidden" name="captcha_id">
              <input type="hidden" name="lot_number">
              <input type="hidden" name="pass_token">
              <input type="hidden" name="gen_time">
              <input type="hidden" name="captcha_output">
            `
            container.appendChild(helper)
          }

          if (helper && solution.text) {
            // Parse the solution - it comes as JSON from 2captcha
            try {
              const solutionData = JSON.parse(solution.text)

              // Set the values in hidden inputs
              const captchaIdInput = helper.querySelector('input[name="captcha_id"]') as HTMLInputElement
              const lotNumberInput = helper.querySelector('input[name="lot_number"]') as HTMLInputElement
              const passTokenInput = helper.querySelector('input[name="pass_token"]') as HTMLInputElement
              const genTimeInput = helper.querySelector('input[name="gen_time"]') as HTMLInputElement
              const captchaOutputInput = helper.querySelector('input[name="captcha_output"]') as HTMLInputElement

              if (captchaIdInput && solutionData.captcha_id) {
                captchaIdInput.value = solutionData.captcha_id
              }
              if (lotNumberInput && solutionData.lot_number) {
                lotNumberInput.value = solutionData.lot_number
              }
              if (passTokenInput && solutionData.pass_token) {
                passTokenInput.value = solutionData.pass_token
              }
              if (genTimeInput && solutionData.gen_time) {
                genTimeInput.value = solutionData.gen_time
              }
              if (captchaOutputInput && solutionData.captcha_output) {
                captchaOutputInput.value = solutionData.captcha_output
              }

              // Try to trigger the captcha callback if available
              const win = window as any
              if (win.captchaObjEventsV4 && win.captchaObjEventsV4.onSuccess) {
                // Call the onSuccess callback with the solution
                win.captchaObjEventsV4.onSuccess()
              }
            } catch (parseError) {
              // If not JSON, try to use the text directly as pass_token
              const passTokenInput = helper.querySelector('input[name="pass_token"]') as HTMLInputElement
              if (passTokenInput && solution.text) {
                passTokenInput.value = solution.text
              }
            }
          }

          // Also check for geetest_v4_response input
          const responseInput = document.querySelector<HTMLInputElement>(
            'input[name="geetest_v4_response"]'
          )
          if (responseInput && solution.text) {
            responseInput.value = solution.text
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
