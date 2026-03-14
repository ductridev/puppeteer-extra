/**
 * Early-injected interceptor script for Cloudflare Turnstile
 *
 * This script is injected via page.evaluateOnNewDocument before any page scripts run.
 * It polls for the window.turnstile object and overrides turnstile.render() to capture
 * widget information at the moment of creation.
 *
 * The captured widget info is stored in window.___turnstile_widgets array for later
 * retrieval by the content script.
 *
 * Race Condition Handling:
 * - Each widget is tagged with a navigationId from window.___turnstile_nav_id
 * - This allows the content script to detect if the page has refreshed since detection
 * - Widgets also include timestamps and hashes for fingerprint verification
 */

/**
 * Widget information captured when turnstile.render() is called
 */
export interface TurnstileWidgetInfo {
  captchaType: 'turnstile'
  widgetId: number
  inputId: string // container ID
  sitekey: string
  callback: string | null // global function name
  cData: string | null
  chlPageData: string | null
  action: string | null
  /** Navigation ID when widget was created (for race condition detection) */
  navigationId?: string
  /** Timestamp when widget was detected */
  detectedAt?: number
  /** Hash of cData for fingerprinting */
  cDataHash?: string
  /** Hash of chlPageData for fingerprinting */
  chlPageDataHash?: string
}

/**
 * The interceptor script as a string to be injected via evaluateOnNewDocument.
 * This is an IIFE (Immediately Invoked Function Expression) that:
 * 1. Polls for window.turnstile object (10ms intervals, up to 3000 polls = 30 seconds)
 * 2. Overrides turnstile.render() to capture widget information
 * 3. Stores widget info in window.___turnstile_widgets array
 * 4. Preserves original callbacks as global window functions
 * 5. Calls the original render function and returns its result
 * 6. Includes navigation ID and fingerprint data for race condition detection
 */
export const interceptorTurnstile = `(${(() => {
  // CRITICAL: Initialize widget storage IMMEDIATELY and SYNCHRONOUSLY
  // This must happen before any other code runs
  const _widgets: any[] = []
  Object.defineProperty(window, '___turnstile_widgets', {
    get: () => _widgets,
    set: () => {}, // Prevent overwriting
    configurable: false,
    enumerable: true
  })

  let _nextWidgetId = 0

  // Simple hash function for fingerprinting
  function _hashString(input) {
    let hash = 0
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return hash.toString(16)
  }

  // Define all functions BEFORE using them

  function _createTurnstileWidget(
    container: any,
    opts: any,
    originalRenderFunc: Function
  ) {
    // Normalize container to ID string
    let containerId: string
    if (typeof container === 'string') {
      containerId = container
    } else {
      if (!container.id) {
        container.id = 'turnstile-container-' + Date.now()
      }
      containerId = container.id
    }

    // Store callback globally if provided
    let callbackKey: string | null = null
    if (opts && opts.callback !== undefined && typeof opts.callback === 'function') {
      callbackKey = 'turnstileCallback' + Date.now()
      ;(window as any)[callbackKey] = opts.callback
    }

    // Get current navigation ID from page context (set by NavigationMonitor)
    const navigationId = (window as any).___turnstile_nav_id || null
    const detectedAt = Date.now()

    // Create hashes for fingerprinting
    const cDataHash = opts?.cData ? _hashString(opts.cData) : null
    const chlPageDataHash = opts?.chlPageData ? _hashString(opts.chlPageData) : null

    // Create widget info with fingerprint data
    const widgetInfo = {
      captchaType: 'turnstile' as const,
      widgetId: _nextWidgetId++,
      inputId: containerId,
      sitekey: opts?.sitekey || '',
      callback: callbackKey,
      cData: opts?.cData || null,
      chlPageData: opts?.chlPageData || null,
      action: opts?.action || null,
      // Race condition detection fields
      navigationId,
      detectedAt,
      cDataHash,
      chlPageDataHash
    }

    // Store widget info
    _widgets.push(widgetInfo)

    // Call original render and return result
    return originalRenderFunc.call(this, container, opts)
  }

  function _overrideTurnstileRender(turnstileObj: any) {
    const originalRenderFunc = turnstileObj.render

    turnstileObj.render = function (container: any, opts: any) {
      return _createTurnstileWidget(container, opts, originalRenderFunc)
    }
  }

  function _startPollingForTurnstile() {
    let pollCount = 0
    const pollInterval = setInterval(() => {
      pollCount++

      const turnstile = (window as any).turnstile
      if (turnstile && turnstile.render) {
        clearInterval(pollInterval)
        _overrideTurnstileRender(turnstile)
      }

      // Timeout after 30 seconds (3000 polls * 10ms)
      if (pollCount > 3000) {
        clearInterval(pollInterval)
      }
    }, 10)
  }

  // Now execute the main logic - check if turnstile already exists
  // This handles the case where turnstile was loaded before our interceptor
  const _existingTurnstile = (window as any).turnstile
  if (_existingTurnstile && _existingTurnstile.render) {
    _overrideTurnstileRender(_existingTurnstile)
  } else {
    // Start polling immediately for turnstile loading
    _startPollingForTurnstile()
  }
}).toString()})()`
