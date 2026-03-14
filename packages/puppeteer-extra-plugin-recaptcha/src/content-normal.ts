import * as types from './types'

export const ContentScriptDefaultOpts: types.ContentScriptOpts = {
  visualFeedback: true
}

export const ContentScriptDefaultData: types.ContentScriptData = {
  solutions: []
}

/**
 * Content script for Normal (image-based) captcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 */
export class NormalContentScript {
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

  /**
   * Find captcha images using various detection patterns
   */
  private _findCaptchaImages(): HTMLImageElement[] {
    const images: HTMLImageElement[] = []

    // Images with captcha-related src patterns
    const srcPatterns = [
      'img[src*="captcha"]',
      'img[src*="captchaid"]',
      'img[src*="kaptcha"]',
      'img[src*="securimage"]',
      'img[src*="securi"]'
    ]

    for (const pattern of srcPatterns) {
      const nodeList = document.querySelectorAll<HTMLImageElement>(pattern)
      nodeList.forEach(img => {
        if (!images.includes(img)) {
          images.push(img)
        }
      })
    }

    // Images with captcha-related alt attributes
    const altPatterns = [
      'img[alt*="captcha"]',
      'img[alt*="Captcha"]',
      'img[alt*="CAPTCHA"]',
      'img[alt*="security code"]',
      'img[alt*="verification"]'
    ]

    for (const pattern of altPatterns) {
      const nodeList = document.querySelectorAll<HTMLImageElement>(pattern)
      nodeList.forEach(img => {
        if (!images.includes(img)) {
          images.push(img)
        }
      })
    }

    // Images with captcha-related onclick handlers
    const onclickImages = document.querySelectorAll<HTMLImageElement>(
      'img[onclick*="captcha"], img[onclick*="reload"]'
    )
    onclickImages.forEach(img => {
      if (!images.includes(img)) {
        images.push(img)
      }
    })

    // Images inside elements with captcha-related classes or IDs
    const containerSelectors = [
      '.captcha img',
      '#captcha img',
      '.captcha-image img',
      '#captcha-image img',
      '[class*="captcha"] img',
      '[id*="captcha"] img'
    ]

    for (const pattern of containerSelectors) {
      const nodeList = document.querySelectorAll<HTMLImageElement>(pattern)
      nodeList.forEach(img => {
        if (!images.includes(img)) {
          images.push(img)
        }
      })
    }

    return images
  }

  /**
   * Find associated input fields for captcha answers
   */
  private _findCaptchaInput(image: HTMLImageElement): HTMLInputElement | null {
    // Common input selectors
    const inputSelectors = [
      'input[name*="captcha"]',
      'input[name="captcha_code"]',
      'input[name="captcha_input"]',
      'input[name="captcha_answer"]',
      'input[name="captchacode"]',
      'input[id*="captcha"]',
      'input[id="captcha"]',
      'input[class*="captcha"]',
      'input[placeholder*="captcha"]',
      'input[placeholder*="code"]',
      'input[type="text"][name*="code"]'
    ]

    // First, try to find input in the same form as the image
    const form = image.closest('form')
    if (form) {
      for (const selector of inputSelectors) {
        const input = form.querySelector<HTMLInputElement>(selector)
        if (input) {
          return input
        }
      }
    }

    // Try to find input near the image (in parent container)
    const parent = image.parentElement
    if (parent) {
      for (const selector of inputSelectors) {
        const input = parent.querySelector<HTMLInputElement>(selector)
        if (input) {
          return input
        }
      }

      // Check siblings
      const grandParent = parent.parentElement
      if (grandParent) {
        for (const selector of inputSelectors) {
          const input = grandParent.querySelector<HTMLInputElement>(selector)
          if (input) {
            return input
          }
        }
      }
    }

    // Fallback: find any captcha input on the page
    for (const selector of inputSelectors) {
      const input = document.querySelector<HTMLInputElement>(selector)
      if (input) {
        return input
      }
    }

    return null
  }

  /**
   * Convert image to base64 string
   */
  private async _imageToBase64(image: HTMLImageElement): Promise<string> {
    // If the image is already a data URL, extract the base64 part
    if (image.src.indexOf('data:image/') !== -1) {
      const base64 = decodeURI(image.src).replace(/\s+/g, '')
      return this._removeDataPrefix(base64)
    }

    // Try to convert via canvas (works for same-origin images)
    try {
      return await this._getBase64ViaCanvas(image)
    } catch (e) {
      // Canvas method failed (likely tainted image), try fetching
      try {
        return await this._getBase64ViaFetch(image.src)
      } catch (fetchError) {
        // Return empty string if all methods fail
        console.error('Failed to convert image to base64:', e)
        return ''
      }
    }
  }

  /**
   * Convert image to base64 using canvas
   */
  private async _getBase64ViaCanvas(image: HTMLImageElement): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth || image.width
        canvas.height = image.naturalHeight || image.height
        const context = canvas.getContext('2d')
        if (!context) {
          reject(new Error('Failed to get canvas context'))
          return
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL('image/png')
        resolve(this._removeDataPrefix(dataUrl))
      } catch (e) {
        reject(e)
      }
    })
  }

  /**
   * Fetch image and convert to base64
   */
  private async _getBase64ViaFetch(url: string): Promise<string> {
    const response = await fetch(url)
    const blob = await response.blob()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const result = reader.result as string
        resolve(this._removeDataPrefix(result))
      }
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  /**
   * Remove data URL prefix from base64 string
   */
  private _removeDataPrefix(base64image: string): string {
    return base64image.replace(/^data:image\/(png|jpg|jpeg|pjpeg|gif|bmp|pict|tiff|webp);base64,/i, '')
  }

  /**
   * Get text instructions if available
   */
  private _getTextInstructions(image: HTMLImageElement): string | undefined {
    // Check for label elements near the image
    const parent = image.parentElement
    if (parent) {
      const label = parent.querySelector('label, .captcha-label, .instructions')
      if (label && label.textContent) {
        return label.textContent.trim()
      }

      // Check for title or alt attribute on the image
      if (image.title) {
        return image.title
      }
    }

    // Check for common instruction elements
    const instructionSelectors = [
      '.captcha-instructions',
      '.captcha-label',
      '#captcha-instructions',
      '[class*="captcha-instruction"]'
    ]

    for (const selector of instructionSelectors) {
      const el = document.querySelector(selector)
      if (el && el.textContent) {
        return el.textContent.trim()
      }
    }

    return undefined
  }

  public async findRecaptchas() {
    const result = {
      captchas: [] as types.CaptchaInfo[],
      error: null as null | Error
    }
    try {
      await this._waitUntilDocumentReady()
      const images = this._findCaptchaImages()

      if (!images.length) {
        return result
      }

      const captchas: types.CaptchaInfo[] = []
      const processedInputs = new Set<HTMLInputElement>()

      for (const image of images) {
        // Find associated input
        const input = this._findCaptchaInput(image)
        if (!input) {
          continue // Skip if no input field found
        }

        // Skip if we've already processed this input
        if (processedInputs.has(input)) {
          continue
        }
        processedInputs.add(input)

        // Convert image to base64
        const base64 = await this._imageToBase64(image)
        if (!base64) {
          continue // Skip if we couldn't get the base64
        }

        // Ensure the image and input have IDs for later reference
        if (!image.id) {
          image.id = `normal-captcha-img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        }
        if (!input.id) {
          input.id = `normal-captcha-input-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        }

        // Get text instructions if available
        const textInstructions = this._getTextInstructions(image)

        const captchaId = `normal_${image.id}`

        const captchaInfo: types.CaptchaInfo = {
          _vendor: 'normal',
          url: document.location.href,
          id: captchaId,
          sitekey: captchaId // Using sitekey as a fallback identifier
        }

        // Store the base64 image data and input ID for the provider
        ;(captchaInfo as any).body = base64
        ;(captchaInfo as any).inputId = input.id
        ;(captchaInfo as any).imageId = image.id
        ;(captchaInfo as any).pageurl = document.location.href
        if (textInstructions) {
          ;(captchaInfo as any).textinstructions = textInstructions
        }

        captchas.push(captchaInfo)

        // Paint visual feedback
        this._paintCaptchaBusy(image)
      }

      result.captchas = captchas
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
        .filter(solution => solution._vendor === 'normal')
        .filter(solution => solution.hasSolution === true)
        .map(solution => {
          // Get the input ID from the solution
          const inputId = (solution as any).inputId
          let responseInput: HTMLInputElement | null = null

          // Try to find the response input by ID
          if (inputId) {
            responseInput = document.querySelector<HTMLInputElement>(`#${inputId}`)
          }

          // Fallback to finding any captcha input
          if (!responseInput) {
            const inputSelectors = [
              'input[name*="captcha"]',
              'input[name="captcha_code"]',
              'input[name="captcha_input"]',
              'input[id*="captcha"]',
              'input[class*="captcha"]'
            ]

            for (const selector of inputSelectors) {
              responseInput = document.querySelector<HTMLInputElement>(selector)
              if (responseInput) break
            }
          }

          // Set the solution text
          if (responseInput && solution.text) {
            responseInput.value = solution.text

            // Dispatch events to trigger validation
            responseInput.dispatchEvent(new Event('input', {
              bubbles: true
            }))
            responseInput.dispatchEvent(new Event('change', {
              bubbles: true
            }))
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
