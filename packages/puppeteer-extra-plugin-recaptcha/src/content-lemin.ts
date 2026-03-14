import * as types from './types'

export const ContentScriptDefaultOpts: types.ContentScriptOpts = {
  visualFeedback: true
}

export const ContentScriptDefaultData: types.ContentScriptData = {
  solutions: []
}

/**
 * Content script for Lemin Cropped Captcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 */
export class LeminContentScript {
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

  /** Find Lemin iframes */
  private _findLeminIframes() {
    const nodeList = document.querySelectorAll<HTMLIFrameElement>(
      'iframe[src*="lemin.com"], iframe[src*="lemin.now"]'
    )
    return Array.from(nodeList)
  }

  /** Find Lemin div containers */
  private _findLeminDivs() {
    const nodeList = document.querySelectorAll<HTMLDivElement>(
      'div.lemin-captcha, div[data-captcha-id], div#lemin-captcha, div.lemin-captcha-input-box'
    )
    return Array.from(nodeList)
  }

  /** Find Lemin hidden inputs */
  private _findLeminInputs() {
    const nodeList = document.querySelectorAll<HTMLInputElement>(
      'input[name="lemin_answer"], input[name="lemin_challenge_key"], input[name="lemin_challenge_id"]'
    )
    return Array.from(nodeList)
  }

  /** Extract captchaId from iframe src */
  private _extractCaptchaIdFromIframe(iframe: HTMLIFrameElement): { captchaId: string | null; divId?: string } {
    try {
      const src = iframe.src
      // Look for captcha_id parameter in the URL
      const url = new URL(src)
      const captchaId = url.searchParams.get('captcha_id')
      if (captchaId) {
        return { captchaId }
      }

      // Try to extract from path pattern: /captcha/v1/cropped/CROPPED_xxx
      const pathMatch = src.match(/\/captcha\/v1\/cropped\/(CROPPED_[A-Za-z0-9_]+)/)
      if (pathMatch) {
        return { captchaId: pathMatch[1] }
      }
    } catch {
      // noop
    }
    return { captchaId: null }
  }

  /** Extract captchaId and divId from scripts */
  private _extractCaptchaIdFromScripts(): { captchaId: string | null; divId?: string; apiServer?: string } {
    try {
      const scripts = document.querySelectorAll('script')
      const scriptUrl = '/captcha/v1/cropped/CROPPED_'

      for (let i = 0; i < scripts.length; i++) {
        const src = scripts[i].getAttribute('src')
        if (typeof src === 'string' && src.indexOf(scriptUrl) > 0) {
          // Extract captcha ID from script URL
          const captchaIdMatch = src.match(/(CROPPED_[A-Za-z0-9_]+)/)
          // Extract API server/domain
          const domainMatch = src.match(/(https?:\/\/[^\/]+)\/captcha\/v1\/cropped\//)

          if (captchaIdMatch) {
            const captchaId = captchaIdMatch[1]
            const apiServer = domainMatch ? domainMatch[1] : undefined

            // Try to find the divId from the container
            const inputBox = document.querySelector('.lemin-captcha-input-box') as HTMLElement
            let divId: string | undefined
            if (inputBox && inputBox.parentElement) {
              divId = inputBox.parentElement.getAttribute('id') || undefined
            }

            return { captchaId, divId, apiServer }
          }
        }
      }
    } catch {
      // noop
    }
    return { captchaId: null }
  }

  /** Extract captchaId from div data attribute */
  private _extractCaptchaIdFromDiv(div: HTMLDivElement): { captchaId: string | null; divId?: string } {
    const captchaId = div.getAttribute('data-captcha-id')
    if (captchaId) {
      return { captchaId, divId: div.id || undefined }
    }

    // Check for nested elements with data-captcha-id
    const nestedElement = div.querySelector('[data-captcha-id]') as HTMLElement
    if (nestedElement) {
      const nestedCaptchaId = nestedElement.getAttribute('data-captcha-id')
      if (nestedCaptchaId) {
        return { captchaId: nestedCaptchaId, divId: div.id || undefined }
      }
    }

    return { captchaId: null }
  }

  /** Check for global lemin objects */
  private _checkGlobalLeminObject(): { captchaId: string | null; divId?: string } | null {
    try {
      // Check for leminCroppedCaptcha global object
      const win = window as any
      if (win.leminCroppedCaptcha) {
        // Try to extract captcha info from the page
        const scripts = document.querySelectorAll('script')
        const scriptUrl = '/captcha/v1/cropped/CROPPED_'

        for (let i = 0; i < scripts.length; i++) {
          const src = scripts[i].getAttribute('src')
          if (typeof src === 'string' && src.indexOf(scriptUrl) > 0) {
            const captchaIdMatch = src.match(/(CROPPED_[A-Za-z0-9_]+)/)
            if (captchaIdMatch) {
              const inputBox = document.querySelector('.lemin-captcha-input-box') as HTMLElement
              let divId: string | undefined
              if (inputBox && inputBox.parentElement) {
                divId = inputBox.parentElement.getAttribute('id') || undefined
              }
              return { captchaId: captchaIdMatch[1], divId }
            }
          }
        }
      }
    } catch {
      // noop
    }
    return null
  }

  private _extractInfoFromElements(
    iframes: HTMLIFrameElement[],
    divs: HTMLDivElement[],
    inputs: HTMLInputElement[]
  ) {
    const results: types.CaptchaInfo[] = []
    const captchaIds = new Set<string>()

    // First try to get captchaId from scripts (most reliable method)
    const scriptData = this._extractCaptchaIdFromScripts()
    if (scriptData.captchaId && !captchaIds.has(scriptData.captchaId)) {
      captchaIds.add(scriptData.captchaId)
      results.push({
        _vendor: 'lemin',
        url: document.location.href,
        sitekey: scriptData.captchaId, // Using sitekey field for captchaId for API compatibility
        captchaId: scriptData.captchaId,
        divId: scriptData.divId,
        apiServer: scriptData.apiServer,
        id: scriptData.captchaId
      } as any)
    }

    // Process iframes
    for (const iframe of iframes) {
      const { captchaId, divId } = this._extractCaptchaIdFromIframe(iframe)
      if (captchaId && !captchaIds.has(captchaId)) {
        captchaIds.add(captchaId)
        results.push({
          _vendor: 'lemin',
          url: document.location.href,
          sitekey: captchaId,
          captchaId,
          divId,
          id: captchaId
        } as any)
      }
    }

    // Process divs
    for (const div of divs) {
      const { captchaId, divId } = this._extractCaptchaIdFromDiv(div)
      if (captchaId && !captchaIds.has(captchaId)) {
        captchaIds.add(captchaId)
        results.push({
          _vendor: 'lemin',
          url: document.location.href,
          sitekey: captchaId,
          captchaId,
          divId: divId || div.id || undefined,
          id: captchaId
        } as any)
      }
    }

    // Check global lemin object as fallback
    if (results.length === 0) {
      const globalData = this._checkGlobalLeminObject()
      if (globalData && globalData.captchaId && !captchaIds.has(globalData.captchaId)) {
        captchaIds.add(globalData.captchaId)
        results.push({
          _vendor: 'lemin',
          url: document.location.href,
          sitekey: globalData.captchaId,
          captchaId: globalData.captchaId,
          divId: globalData.divId,
          id: globalData.captchaId
        } as any)
      }
    }

    // If we have inputs but no captchaId yet, try to find captcha from page context
    if (results.length === 0 && inputs.length > 0) {
      // Look for captcha ID in script tags
      const scriptTags = Array.from(document.querySelectorAll('script'))
      for (const script of scriptTags) {
        const content = script.textContent || ''
        const src = script.getAttribute('src') || ''

        // Check script content for CROPPED_ pattern
        const contentMatch = content.match(/(CROPPED_[A-Za-z0-9_]+)/)
        if (contentMatch && !captchaIds.has(contentMatch[1])) {
          captchaIds.add(contentMatch[1])
          results.push({
            _vendor: 'lemin',
            url: document.location.href,
            sitekey: contentMatch[1],
            captchaId: contentMatch[1],
            id: contentMatch[1]
          } as any)
          break
        }

        // Check script src for CROPPED_ pattern
        const srcMatch = src.match(/(CROPPED_[A-Za-z0-9_]+)/)
        if (srcMatch && !captchaIds.has(srcMatch[1])) {
          captchaIds.add(srcMatch[1])
          results.push({
            _vendor: 'lemin',
            url: document.location.href,
            sitekey: srcMatch[1],
            captchaId: srcMatch[1],
            id: srcMatch[1]
          } as any)
          break
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
      const iframes = this._findLeminIframes()
      const divs = this._findLeminDivs()
      const inputs = this._findLeminInputs()

      if (!iframes.length && !divs.length && !inputs.length) {
        return result
      }

      result.captchas = this._extractInfoFromElements(iframes, divs, inputs)

      // Paint visual feedback on found elements
      iframes.forEach(el => this._paintCaptchaBusy(el))
      divs.forEach(el => this._paintCaptchaBusy(el))
      inputs.forEach(el => this._paintCaptchaBusy(el))
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
        .filter(solution => solution._vendor === 'lemin')
        .filter(solution => solution.hasSolution === true)
        .map(solution => {
          // Find the Lemin response input elements
          const leminAnswerInput = document.querySelector<HTMLInputElement>(
            'input[name="lemin_answer"]'
          )
          const leminChallengeIdInput = document.querySelector<HTMLInputElement>(
            'input[name="lemin_challenge_id"]'
          )
          const leminChallengeKeyInput = document.querySelector<HTMLInputElement>(
            'input[name="lemin_challenge_key"]'
          )

          // Set the solution values
          if (solution.text) {
            // Parse the solution - it may be JSON or just the answer
            try {
              const solutionData = JSON.parse(solution.text)

              if (leminAnswerInput && solutionData.answer) {
                leminAnswerInput.value = solutionData.answer
              }
              if (leminChallengeIdInput && solutionData.challenge_id) {
                leminChallengeIdInput.value = solutionData.challenge_id
              }
              if (leminChallengeKeyInput && solutionData.challenge_key) {
                leminChallengeKeyInput.value = solutionData.challenge_key
              }
            } catch {
              // If not JSON, treat as simple answer
              if (leminAnswerInput) {
                leminAnswerInput.value = solution.text
              }
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
