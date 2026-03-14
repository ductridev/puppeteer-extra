import * as types from './types'

export const ContentScriptDefaultOpts: types.ContentScriptOpts = {
  visualFeedback: true
}

export const ContentScriptDefaultData: types.ContentScriptData = {
  solutions: []
}

/**
 * Content script for Capy Puzzle captcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 */
export class CapyContentScript {
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

  /** Find Capy iframes */
  private _findCapyIframes() {
    const nodeList = document.querySelectorAll<HTMLIFrameElement>(
      'iframe[src*="capy.me"], iframe[src*="capy.puzzle"], iframe[src*="api.capy.me"]'
    )
    return Array.from(nodeList)
  }

  /** Find Capy div containers */
  private _findCapyDivs() {
    const nodeList = document.querySelectorAll<HTMLDivElement>(
      'div.capy-captcha, div.capy-wrapper, div[data-sitekey][class*="capy"]'
    )
    return Array.from(nodeList)
  }

  /** Find Capy hidden inputs */
  private _findCapyInputs() {
    const nodeList = document.querySelectorAll<HTMLInputElement>(
      'input[name="capy_captchakey"], input.capy-captcha'
    )
    return Array.from(nodeList)
  }

  /** Extract sitekey from iframe src */
  private _extractSitekeyFromIframe(iframe: HTMLIFrameElement): { sitekey: string | null; apiServer?: string } {
    try {
      const src = iframe.src
      const url = new URL(src)

      // Look for 'k' parameter in the URL (e.g., /puzzle/get_js/?k=PUZZLE_xxx)
      const kParam = url.searchParams.get('k')
      if (kParam) {
        return { sitekey: kParam, apiServer: url.origin }
      }

      // Try to extract from path
      const pathMatch = src.match(/k=([A-Za-z0-9_]+)/)
      if (pathMatch) {
        return { sitekey: pathMatch[1], apiServer: url.origin }
      }
    } catch {
      // noop
    }
    return { sitekey: null }
  }

  /** Extract sitekey from scripts (alternative method) */
  private _extractSitekeyFromScripts(): { sitekey: string | null; apiServer?: string } {
    try {
      const scripts = document.querySelectorAll('script')
      const scriptUrl = '/puzzle/get_js/?k=PUZZLE_'

      for (let i = 0; i < scripts.length; i++) {
        const src = scripts[i].getAttribute('src')
        if (typeof src === 'string' && src.indexOf(scriptUrl) > 0) {
          const url = new URL(src)
          const apiServer = url.origin
          const match = src.match(/k=(PUZZLE_[A-Za-z0-9_]+)/)
          if (match) {
            return { sitekey: match[1], apiServer }
          }
        }
      }
    } catch {
      // noop
    }
    return { sitekey: null }
  }

  /** Extract sitekey from hidden input */
  private _extractSitekeyFromInput(input: HTMLInputElement): string | null {
    return input.value || null
  }

  private _extractInfoFromElements(
    iframes: HTMLIFrameElement[],
    divs: HTMLDivElement[],
    inputs: HTMLInputElement[]
  ) {
    const results: types.CaptchaInfo[] = []
    const sitekeys = new Set<string>()

    // First try to get sitekey from scripts (most reliable)
    const scriptData = this._extractSitekeyFromScripts()

    // Process iframes
    for (const iframe of iframes) {
      const { sitekey, apiServer } = this._extractSitekeyFromIframe(iframe)
      if (sitekey && !sitekeys.has(sitekey)) {
        sitekeys.add(sitekey)
        results.push({
          _vendor: 'capy',
          url: document.location.href,
          sitekey,
          apiServer,
          id: sitekey
        })
      }
    }

    // Use script data as fallback/primary if no iframe data
    if (results.length === 0 && scriptData.sitekey) {
      sitekeys.add(scriptData.sitekey)
      results.push({
        _vendor: 'capy',
        url: document.location.href,
        sitekey: scriptData.sitekey,
        apiServer: scriptData.apiServer,
        id: scriptData.sitekey
      })
    }

    // Process divs
    for (const div of divs) {
      const sitekey = div.getAttribute('data-sitekey')
      if (sitekey && !sitekeys.has(sitekey)) {
        sitekeys.add(sitekey)
        results.push({
          _vendor: 'capy',
          url: document.location.href,
          sitekey,
          id: sitekey
        })
      }
    }

    // Process inputs (alternative detection)
    for (const input of inputs) {
      const sitekey = this._extractSitekeyFromInput(input)
      if (sitekey && !sitekeys.has(sitekey)) {
        sitekeys.add(sitekey)
        results.push({
          _vendor: 'capy',
          url: document.location.href,
          sitekey,
          apiServer: 'https://www.capy.me',
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
      const iframes = this._findCapyIframes()
      const divs = this._findCapyDivs()
      const inputs = this._findCapyInputs()

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
        .filter(solution => solution._vendor === 'capy')
        .filter(solution => solution.hasSolution === true)
        .map(solution => {
          // Find the Capy response input elements
          const capyCaptchaKeyInput = document.querySelector<HTMLInputElement>(
            'input[name="capy_captchakey"]'
          )
          const captchaKeyInput = document.querySelector<HTMLInputElement>(
            'input[name="captchakey"]'
          )
          const challengeKeyInput = document.querySelector<HTMLInputElement>(
            'input[name="capy_challengekey"]'
          )
          const answerInput = document.querySelector<HTMLInputElement>(
            'input[name="capy_answer"]'
          )

          // Set the solution values
          // The solution text contains the captchakey from the solver
          if (solution.text) {
            // Parse the solution - it may be JSON or just the token
            try {
              const solutionData = JSON.parse(solution.text)

              if (capyCaptchaKeyInput && solutionData.captchakey) {
                capyCaptchaKeyInput.value = solutionData.captchakey
              }
              if (captchaKeyInput && solutionData.captchakey) {
                captchaKeyInput.value = solutionData.captchakey
              }
              if (challengeKeyInput && solutionData.challengekey) {
                challengeKeyInput.value = solutionData.challengekey
              }
              if (answerInput && solutionData.answer) {
                answerInput.value = solutionData.answer
              }
            } catch {
              // If not JSON, treat as simple token
              if (capyCaptchaKeyInput) {
                capyCaptchaKeyInput.value = solution.text
              }
              if (captchaKeyInput) {
                captchaKeyInput.value = solution.text
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
