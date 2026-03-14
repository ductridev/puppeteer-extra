import * as types from './types'

export const ContentScriptDefaultOpts: types.ContentScriptOpts = {
  visualFeedback: true
}

export const ContentScriptDefaultData: types.ContentScriptData = {
  solutions: []
}

/**
 * Content script for GeeTest V3 captcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 */
export class GeetestContentScript {
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

  /** Check for initGeetest global function (V3, not V4) */
  private _hasInitGeetest() {
    const win = window as any
    // V3 has initGeetest but NOT initGeetest4
    return typeof win.initGeetest !== 'undefined' && typeof win.initGeetest4 === 'undefined'
  }

  /** Find GeeTest V3 iframes (geetest.com but not v4) */
  private _findGeetestIframes() {
    const nodeList = document.querySelectorAll<HTMLIFrameElement>(
      `iframe[src*="geetest.com"]`
    )
    // Filter out V4 iframes
    return Array.from(nodeList).filter(iframe => {
      const src = iframe.src
      // V4 has "geetest.v4" or "gcaptcha4" in URL
      return !src.includes('geetest.v4') && !src.includes('gcaptcha4')
    })
  }

  /** Find GeeTest V3 containers */
  private _findGeetestContainers() {
    const nodeList = document.querySelectorAll<HTMLDivElement>(
      'div.geetest_captcha, div[data-gt]:not([data-captcha-id])'
    )
    return Array.from(nodeList)
  }

  /** Extract gt and challenge from iframe src */
  private _extractInfoFromIframe(iframe: HTMLIFrameElement): { gt: string | null; challenge: string | null; apiServer?: string } {
    try {
      const src = iframe.src
      const url = new URL(src)
      const gt = url.searchParams.get('gt')
      const challenge = url.searchParams.get('challenge')
      const apiServer = url.searchParams.get('api_server') || undefined

      return { gt, challenge, apiServer }
    } catch {
      // noop
    }
    return { gt: null, challenge: null }
  }

  /** Extract gt and challenge from container attributes */
  private _extractInfoFromContainer(container: HTMLDivElement): { gt: string | null; challenge: string | null; apiServer?: string } {
    const gt = container.getAttribute('data-gt')
    const challenge = container.getAttribute('data-challenge')
    const apiServer = container.getAttribute('data-api-server') || undefined

    return { gt, challenge, apiServer }
  }

  /** Extract gt and challenge from global geetest configuration */
  private _extractInfoFromGlobals(): { gt: string | null; challenge: string | null; apiServer?: string } {
    try {
      const win = window as any

      // Check for geetest configuration in window
      if (win.geetest_gt && win.geetest_challenge) {
        return {
          gt: win.geetest_gt,
          challenge: win.geetest_challenge,
          apiServer: win.geetest_api_server
        }
      }

      // Check for captchaObj configuration
      if (win.captchaObj && win.captchaObj.params) {
        const params = win.captchaObj.params
        return {
          gt: params.gt,
          challenge: params.challenge,
          apiServer: params.api_server
        }
      }
    } catch {
      // noop
    }
    return { gt: null, challenge: null }
  }

  /** Extract info from script tags */
  private _extractInfoFromScripts(): { gt: string | null; challenge: string | null; apiServer?: string } {
    try {
      const scripts = document.querySelectorAll('script')

      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i]
        const text = script.textContent || ''

        // Look for gt and challenge in script content
        const gtMatch = text.match(/gt\s*[:=]\s*['"]([a-f0-9]+)['"]/i)
        const challengeMatch = text.match(/challenge\s*[:=]\s*['"]([a-f0-9]+)['"]/i)

        if (gtMatch && challengeMatch) {
          return {
            gt: gtMatch[1],
            challenge: challengeMatch[1]
          }
        }
      }
    } catch {
      // noop
    }
    return { gt: null, challenge: null }
  }

  private _extractInfoFromElements(
    iframes: HTMLIFrameElement[],
    containers: HTMLDivElement[]
  ) {
    const results: types.CaptchaInfo[] = []
    const seenKeys = new Set<string>()

    // Process iframes
    for (const iframe of iframes) {
      const { gt, challenge, apiServer } = this._extractInfoFromIframe(iframe)
      if (gt && challenge) {
        const key = `${gt}-${challenge}`
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          results.push({
            _vendor: 'geetest',
            url: document.location.href,
            sitekey: gt, // Using sitekey field to store gt for API compatibility
            id: `${gt}-${challenge}`,
            // Store additional data in custom properties
            ...{ gt, challenge, apiServer }
          } as any)
        }
      }
    }

    // Process containers
    for (const container of containers) {
      const { gt, challenge, apiServer } = this._extractInfoFromContainer(container)
      if (gt && challenge) {
        const key = `${gt}-${challenge}`
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          results.push({
            _vendor: 'geetest',
            url: document.location.href,
            sitekey: gt,
            id: `${gt}-${challenge}`,
            ...{ gt, challenge, apiServer }
          } as any)
        }
      } else if (gt && !challenge) {
        // Some containers only have gt, need to get challenge from elsewhere
        const key = `${gt}`
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          results.push({
            _vendor: 'geetest',
            url: document.location.href,
            sitekey: gt,
            id: gt,
            ...{ gt, challenge: null, apiServer }
          } as any)
        }
      }
    }

    // If no captcha found but initGeetest exists, try to get from scripts/globals
    if (results.length === 0 && this._hasInitGeetest()) {
      let info = this._extractInfoFromScripts()
      if (!info.gt) {
        info = this._extractInfoFromGlobals()
      }

      if (info.gt) {
        const key = info.challenge ? `${info.gt}-${info.challenge}` : info.gt
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          results.push({
            _vendor: 'geetest',
            url: document.location.href,
            sitekey: info.gt,
            id: key,
            ...info
          } as any)
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
      const iframes = this._findGeetestIframes()
      const containers = this._findGeetestContainers()

      if (!iframes.length && !containers.length && !this._hasInitGeetest()) {
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
        .filter(solution => solution._vendor === 'geetest')
        .filter(solution => solution.hasSolution === true)
        .map(solution => {
          // Find the geetest response container
          const container = document.querySelector('.geetest_captcha, div[data-gt]')

          // Create or find the helper div for storing solution values
          let helper = container?.querySelector('.twocaptcha-geetest-helper') as HTMLDivElement

          if (!helper && container) {
            helper = document.createElement('div')
            helper.className = 'twocaptcha-geetest-helper'
            helper.innerHTML = `
              <div class="geetest_form">
                <input type="hidden" name="geetest_challenge">
                <input type="hidden" name="geetest_validate">
                <input type="hidden" name="geetest_seccode">
              </div>
            `
            container.appendChild(helper)
          }

          if (helper && solution.text) {
            // Parse the solution - it comes as JSON from 2captcha
            try {
              const solutionData = JSON.parse(solution.text)

              // Set the values in hidden inputs
              const challengeInput = helper.querySelector('input[name="geetest_challenge"]') as HTMLInputElement
              const validateInput = helper.querySelector('input[name="geetest_validate"]') as HTMLInputElement
              const seccodeInput = helper.querySelector('input[name="geetest_seccode"]') as HTMLInputElement

              if (challengeInput && solutionData.challenge) {
                challengeInput.value = solutionData.challenge
              }
              if (validateInput && solutionData.validate) {
                validateInput.value = solutionData.validate
              }
              if (seccodeInput && solutionData.seccode) {
                seccodeInput.value = solutionData.seccode
              }

              // Try to trigger the captcha callback if available
              const win = window as any
              if (win.captchaObjEvents && win.captchaObjEvents.onSuccessCallback) {
                // Update the getValidate function to return our solution
                if (win.captchaObj) {
                  win.captchaObj.getValidate = function() {
                    return {
                      geetest_challenge: solutionData.challenge || '',
                      geetest_validate: solutionData.validate || '',
                      geetest_seccode: solutionData.seccode || ''
                    }
                  }
                }
                // Call the onSuccess callback with the captcha object
                win.captchaObjEvents.onSuccessCallback(win.captchaObj)
              }
            } catch (parseError) {
              // If not JSON, try to use the text directly
              // The solution might be in format: challenge|validate|seccode
              const parts = solution.text.split('|')
              if (parts.length >= 3) {
                const challengeInput = helper.querySelector('input[name="geetest_challenge"]') as HTMLInputElement
                const validateInput = helper.querySelector('input[name="geetest_validate"]') as HTMLInputElement
                const seccodeInput = helper.querySelector('input[name="geetest_seccode"]') as HTMLInputElement

                if (challengeInput) challengeInput.value = parts[0]
                if (validateInput) validateInput.value = parts[1]
                if (seccodeInput) seccodeInput.value = parts[2]
              }
            }
          }

          // Also check for existing geetest response inputs
          const existingChallengeInput = document.querySelector<HTMLInputElement>(
            'input[name="geetest_challenge"]'
          )
          const existingValidateInput = document.querySelector<HTMLInputElement>(
            'input[name="geetest_validate"]'
          )
          const existingSeccodeInput = document.querySelector<HTMLInputElement>(
            'input[name="geetest_seccode"]'
          )

          if (solution.text) {
            try {
              const solutionData = JSON.parse(solution.text)
              if (existingChallengeInput && solutionData.challenge) {
                existingChallengeInput.value = solutionData.challenge
              }
              if (existingValidateInput && solutionData.validate) {
                existingValidateInput.value = solutionData.validate
              }
              if (existingSeccodeInput && solutionData.seccode) {
                existingSeccodeInput.value = solutionData.seccode
              }
            } catch {
              // noop
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
