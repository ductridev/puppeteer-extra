export const PROVIDER_ID = '2captcha'
import * as types from '../types'

import Debug from 'debug'
const debug = Debug(`puppeteer-extra-plugin:recaptcha:${PROVIDER_ID}`)

// const solver = require('./2captcha-api')
import * as solver from './2captcha-api'

const secondsBetweenDates = (before: Date, after: Date) =>
  (after.getTime() - before.getTime()) / 1000

export interface DecodeRecaptchaAsyncResult {
  err?: any
  result?: any
  invalid?: any
}

export interface TwoCaptchaProviderOpts {
  useEnterpriseFlag?: boolean
  useActionValue?: boolean
}

const providerOptsDefaults: TwoCaptchaProviderOpts = {
  useEnterpriseFlag: false, // Seems to make solving chance worse?
  useActionValue: true
}

async function decodeRecaptchaAsync(
  token: string,
  vendor: types.CaptchaVendor,
  sitekey: string,
  url: string,
  extraData: any,
  opts = { pollingInterval: 2000 }
): Promise<DecodeRecaptchaAsyncResult> {
  return new Promise(resolve => {
    const cb = (err: any, result: any, invalid: any) =>
      resolve({ err, result, invalid })
    try {
      solver.setApiKey(token)

      if (vendor === 'turnstile') {
        solver.solveTurnstile(
          {
            sitekey,
            pageurl: url,
            ...extraData
          },
          opts,
          cb
        )
        return
      }

      if (vendor === 'geetest_v4') {
        solver.solveGeetestV4(
          {
            captchaId: sitekey,
            pageurl: url
          },
          opts,
          cb
        )
        return
      }

      if (vendor === 'geetest') {
        solver.solveGeetest(
          {
            gt: extraData.gt || sitekey,
            challenge: extraData.challenge,
            pageurl: url,
            apiServer: extraData.apiServer
          },
          opts,
          cb
        )
        return
      }

      if (vendor === 'arkoselabs') {
        solver.solveArkoseLabs(
          {
            publickey: sitekey,
            pageurl: url,
            ...extraData
          },
          opts,
          cb
        )
        return
      }

      if (vendor === 'amazon_waf') {
        solver.solveAmazonWaf(
          {
            sitekey,
            pageurl: url,
            iv: extraData.iv,
            context: extraData.context
          },
          opts,
          cb
        )
        return
      }

      if (vendor === 'yandex') {
        solver.solveYandex(
          {
            sitekey,
            pageurl: url
          },
          opts,
          cb
        )
        return
      }

      if (vendor === 'capy') {
        solver.solveCapy(
          {
            sitekey,
            pageurl: url,
            apiServer: extraData.apiServer
          },
          opts,
          cb
        )
        return
      }

      if (vendor === 'lemin') {
        solver.solveLemin(
          {
            captchaId: sitekey,
            pageurl: url,
            divId: extraData.divId,
            apiServer: extraData.apiServer
          },
          opts,
          cb
        )
        return
      }

      if (vendor === 'keycaptcha') {
        solver.solveKeyCaptcha(
          {
            s_s_c_user_id: extraData.s_s_c_user_id,
            s_s_c_session_id: extraData.s_s_c_session_id,
            s_s_c_web_server_sign: extraData.s_s_c_web_server_sign,
            s_s_c_web_server_sign2: extraData.s_s_c_web_server_sign2,
            pageurl: url
          },
          opts,
          cb
        )
        return
      }

      if (vendor === 'normal') {
        solver.solveNormal(
          {
            body: extraData.body,
            pageurl: url,
            textinstructions: extraData.textinstructions,
            imginstructions: extraData.imginstructions
          },
          opts,
          cb
        )
        return
      }

      let method = 'userrecaptcha'
      if (vendor === 'hcaptcha') {
        method = 'hcaptcha'
      }
      solver.decodeReCaptcha(method, sitekey, url, extraData, opts, cb)
    } catch (error) {
      return resolve({ err: error })
    }
  })
}

export async function getSolutions(
  captchas: types.CaptchaInfo[] = [],
  token: string = '',
  opts: TwoCaptchaProviderOpts = {}
): Promise<types.GetSolutionsResult> {
  opts = { ...providerOptsDefaults, ...opts }
  const solutions = await Promise.all(
    captchas.map(c => getSolution(c, token, opts))
  )
  return { solutions, error: solutions.find(s => !!s.error) }
}

async function getSolution(
  captcha: types.CaptchaInfo,
  token: string,
  opts: TwoCaptchaProviderOpts
): Promise<types.CaptchaSolution> {
  const solution: types.CaptchaSolution = {
    _vendor: captcha._vendor,
    provider: PROVIDER_ID
  }
  try {
    if (!captcha || !captcha.sitekey || !captcha.url || !captcha.id) {
      throw new Error('Missing data in captcha')
    }
    solution.id = captcha.id
    // Copy widgetId for Turnstile widgets (needed for solution application)
    if (captcha.widgetId !== undefined) {
      solution.widgetId = captcha.widgetId
      debug('Copied widgetId from captcha:', captcha.widgetId)
    }
    // Copy fingerprint for race condition detection (Turnstile)
    if (captcha.fingerprint) {
      solution.fingerprint = captcha.fingerprint
      debug('Copied fingerprint from captcha:', captcha.fingerprint)
    }
    solution.requestAt = new Date()
    debug('Requesting solution..', solution)
    const extraData = {}
    if (captcha.s) {
      extraData['data-s'] = captcha.s // google site specific property
    }
    if (opts.useActionValue && captcha.action) {
      extraData['action'] = captcha.action // Optional v3/enterprise action
    }
    if (opts.useEnterpriseFlag && captcha.isEnterprise) {
      extraData['enterprise'] = 1
    }

    // Turnstile-specific fields
    // cData maps to 'data' parameter in2captcha API
    if (captcha.cData) {
      extraData['data'] = captcha.cData
      debug('Turnstile cData:', captcha.cData)
    }
    // chlPageData maps to 'pagedata' parameter in2captcha API
    if (captcha.chlPageData) {
      extraData['pagedata'] = captcha.chlPageData
      debug('Turnstile chlPageData:', captcha.chlPageData)
    }

    if (process.env['2CAPTCHA_PROXY_TYPE'] && process.env['2CAPTCHA_PROXY_ADDRESS']) {
         extraData['proxytype'] = process.env['2CAPTCHA_PROXY_TYPE'].toUpperCase()
         extraData['proxy'] = process.env['2CAPTCHA_PROXY_ADDRESS']
    }

    const { err, result, invalid } = await decodeRecaptchaAsync(
      token,
      captcha._vendor,
      captcha.sitekey,
      captcha.url,
      extraData
    )
    debug('Got response', { err, result, invalid })
    if (err) throw new Error(`${PROVIDER_ID} error: ${err}`)
    if (!result || !result.text || !result.id) {
      throw new Error(`${PROVIDER_ID} error: Missing response data: ${result}`)
    }
    solution.providerCaptchaId = result.id
    solution.text = result.text
    solution.responseAt = new Date()
    solution.hasSolution = !!solution.text
    solution.duration = secondsBetweenDates(
      solution.requestAt,
      solution.responseAt
    )
  } catch (error) {
    debug('Error', error)
    solution.error = error.toString()
  }
  return solution
}
