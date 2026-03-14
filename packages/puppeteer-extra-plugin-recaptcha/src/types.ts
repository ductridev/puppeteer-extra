/// <reference path="./puppeteer-mods.d.ts" />
/// <reference path="./playwright-mods.d.ts" />
// Warn: The above is EXTREMELY important for our custom page mods to be recognized by the end users typescript!

/**
 * Widget information captured by the Turnstile interceptor
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
 * Extend window object with recaptcha things
 */
declare global {
  interface Window {
    __google_recaptcha_client?: boolean
    ___grecaptcha_cfg?: {
      clients?: any
    }
    ___turnstile_widgets?: TurnstileWidgetInfo[]
    /** Current navigation ID for race condition detection */
    ___turnstile_nav_id?: string
  }
}

export type RecaptchaPluginPageAdditions = {
  /** Attempt to find all reCAPTCHAs on this page. */
  findRecaptchas: () => Promise<FindRecaptchasResult>

  getRecaptchaSolutions: (
    captchas: CaptchaInfo[],
    provider?: SolutionProvider
  ) => Promise<GetSolutionsResult>

  enterRecaptchaSolutions: (
    solutions: CaptchaSolution[]
  ) => Promise<EnterRecaptchaSolutionsResult>

  /** Attempt to detect and solve reCAPTCHAs on this page automatically. 🔮 */
  solveRecaptchas: () => Promise<SolveRecaptchasResult>
}

export interface SolutionProvider<TOpts = any> {
  id?: string
  token?: string
  fn?: (captchas: CaptchaInfo[], token?: string) => Promise<GetSolutionsResult>
  opts?: TOpts // Optional options ;-)
}

export interface FindRecaptchasResult {
  captchas: CaptchaInfo[]
  filtered: FilteredCaptcha[]
  error?: any
}
export interface EnterRecaptchaSolutionsResult {
  solved: CaptchaSolved[]
  error?: any
  /** Solutions that were invalidated due to race condition (page navigation) */
  invalidated?: CaptchaSolution[]
}
export interface GetSolutionsResult {
  solutions: CaptchaSolution[]
  error?: any
}

export type SolveRecaptchasResult = FindRecaptchasResult &
  EnterRecaptchaSolutionsResult &
  GetSolutionsResult

export type CaptchaVendor = 'recaptcha' | 'hcaptcha' | 'turnstile' | 'geetest' | 'geetest_v4' | 'arkoselabs' | 'amazon_waf' | 'yandex' | 'capy' | 'lemin' | 'keycaptcha' | 'normal'

export type CaptchaType = 'checkbox' | 'invisible' | 'score'

export interface TurnstileCaptchaInfo {
  sitekey: string
  pageurl: string
  action?: string
  data?: string
  pagedata?: string
}

export interface TurnstileCaptchaSolution {
  token: string
}

export interface GeetestV4CaptchaInfo {
  captchaId: string
  pageurl: string
}

export interface GeetestV4CaptchaSolution {
  lot_number: string
  pass_token: string
  gen_time: string
  captcha_output?: string
}

export interface GeetestCaptchaInfo {
  gt: string
  challenge: string
  pageurl: string
  apiServer?: string
}

export interface GeetestCaptchaSolution {
  challenge: string
  validate: string
  seccode: string
}

export interface ArkoseLabsCaptchaInfo {
  publicKey: string
  pageurl: string
  surl?: string
  data?: object
}

export interface ArkoseLabsCaptchaSolution {
  token: string
}

export interface AmazonWafCaptchaInfo {
  sitekey: string
  pageurl: string
  iv?: string
  context?: string
}

export interface AmazonWafCaptchaSolution {
  captchaVerification: string
}

export interface YandexCaptchaInfo {
  sitekey: string
  pageurl: string
}

export interface YandexCaptchaSolution {
  token: string
}

export interface CapyCaptchaInfo {
  sitekey: string
  pageurl: string
  apiServer?: string
}

export interface CapyCaptchaSolution {
  captchakey: string
}

export interface LeminCaptchaInfo {
  captchaId: string
  pageurl: string
  divId?: string
}

export interface LeminCaptchaSolution {
  answer: string
}

export interface KeyCaptchaInfo {
  s_s_c_user_id: string
  s_s_c_session_id: string
  s_s_c_web_server_sign: string
  s_s_c_web_server_sign2: string
  pageurl: string
}

export interface KeyCaptchaSolution {
  token: string
}

export interface NormalCaptchaInfo {
  body: string
  pageurl: string
  textinstructions?: string
  imginstructions?: string
}

export interface NormalCaptchaSolution {
  text: string
}

export interface CaptchaInfo {
  _vendor: CaptchaVendor
  id?: string // captcha id
  widgetId?: number
  sitekey?: string
  s?: string // new google site specific property
  isEnterprise?: boolean
  isInViewport?: boolean
  /** Is captcha invisible */
  isInvisible?: boolean
  /** Invisible recaptchas: Does the captcha have an active challenge popup */
  hasActiveChallengePopup?: boolean
  /** Invisible recaptchas: Can the captcha trigger a challenge or is it purely score based (v3) */
  hasChallengeFrame?: boolean
  _type?: CaptchaType
  action?: string // Optional action (v3/enterprise): https://developers.google.com/recaptcha/docs/v3#actions
  callback?: string | Function
  hasResponseElement?: boolean
  url?: string
  /** Amazon WAF specific fields */
  iv?: string
  context?: string
  /** Capy/Geetest API server override */
  apiServer?: string
  /** Turnstile-specific fields */
  cData?: string // Turnstile cData parameter (maps to 'data' in2captcha API)
  chlPageData?: string // Turnstile chlPageData parameter (maps to 'pagedata' in2captcha API)
  display?: {
    size?: string
    theme?: string
    top?: string
    left?: string
    width?: string
    height?: string
  }
  /** Fingerprint for race condition detection (Turnstile) */
  fingerprint?: CaptchaFingerprint
}

export type FilteredCaptcha = CaptchaInfo & {
  filtered: boolean
  filteredReason:
    | 'solveInViewportOnly'
    | 'solveScoreBased'
    | 'solveInactiveChallenges'
}

export interface CaptchaSolution {
  _vendor: CaptchaVendor
  id?: string // captcha id
  provider?: string
  providerCaptchaId?: string
  text?: string // the solution
  requestAt?: Date
  responseAt?: Date
  duration?: number
  error?: string | Error
  hasSolution?: boolean
  /** Fingerprint for race condition detection (Turnstile) */
  fingerprint?: CaptchaFingerprint
  /** Widget ID for correlation */
  widgetId?: number
}

export interface CaptchaSolved {
  _vendor: CaptchaVendor
  id?: string // captcha id
  responseElement?: boolean
  responseCallback?: boolean
  solvedAt?: Date
  error?: string | Error
  isSolved?: boolean
}

export interface PluginOptions {
  /** Visualize reCAPTCHAs based on their state */
  visualFeedback: boolean
  /** Throw on errors instead of returning them in the error property */
  throwOnError: boolean

  /** Only solve captchas and challenges visible in the viewport */
  solveInViewportOnly: boolean
  /** Solve invisible captchas used to acquire a score and not present a challenge (e.g. reCAPTCHA v3) */
  solveScoreBased: boolean
  /** Solve invisible captchas that have no active challenge */
  solveInactiveChallenges: boolean

  provider?: SolutionProvider
}

export interface ContentScriptOpts {
  visualFeedback: boolean
  debugBinding?: string
}

export interface ContentScriptData {
  solutions?: CaptchaSolution[]
  navigationId?: string
}

/**
 * Fingerprint for captcha challenge identification
 * Used to detect race conditions when page refreshes during solving
 */
export interface CaptchaFingerprint {
  /** Navigation ID when captcha was detected */
  navigationId: string
  /** Sitekey of the captcha */
  sitekey: string
  /** Hash of cData parameter if available */
  cDataHash?: string
  /** Hash of chlPageData parameter if available */
  chlPageDataHash?: string
  /** Timestamp when captcha was detected */
  timestamp: number
  /** Widget ID for correlation */
  widgetId?: number
}

/**
 * Solution state for tracking through the solve lifecycle
 */
export type SolutionState = 'pending' | 'ready' | 'applied' | 'invalidated'

/**
 * Tracked solution with state and fingerprint
 */
export interface TrackedSolution {
  solution: CaptchaSolution
  fingerprint: CaptchaFingerprint
  status: SolutionState
  invalidateReason?: 'page_navigation' | 'fingerprint_mismatch'
}

/**
 * Result of solution verification
 */
export interface SolutionVerificationResult {
  valid: boolean
  currentFingerprint?: CaptchaFingerprint
  reason?: string
}

/**
 * Extended widget info with fingerprint data
 */
export interface TurnstileWidgetInfoWithFingerprint extends TurnstileWidgetInfo {
  /** Navigation ID when widget was created */
  navigationId: string
  /** Timestamp when widget was created */
  detectedAt: number
  /** Hash of cData for fingerprinting */
  cDataHash?: string
  /** Hash of chlPageData for fingerprinting */
  chlPageDataHash?: string
}

/**
 * Navigation event data
 */
export interface NavigationEvent {
  /** Unique navigation ID */
  navigationId: string
  /** Previous navigation ID (if any) */
  previousNavigationId?: string
  /** Timestamp of navigation */
  timestamp: number
  /** URL being navigated to */
  url?: string
}
