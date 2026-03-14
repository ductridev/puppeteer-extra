// https://github.com/bochkarev-artem/2captcha/blob/master/index.js
// TODO: Create our own API wrapper

var https = require('https')
var url = require('url')
var querystring = require('querystring')

var apiKey
var apiInUrl = 'https://2captcha.com/in.php'
var apiResUrl = 'https://2captcha.com/res.php'
var apiMethod = 'base64'
var SOFT_ID = '2589'

var defaultOptions = {
  pollingInterval: 2000,
  retries: 3
}

function pollCaptcha(captchaId, options, invalid, callback) {
  invalid = invalid.bind({ options: options, captchaId: captchaId })
  var intervalId = setInterval(function() {
    var httpsRequestOptions = url.parse(
      apiResUrl +
        '?action=get&soft_id=' +
        SOFT_ID +
        '&key=' +
        apiKey +
        '&id=' +
        captchaId
    )
    var request = https.request(httpsRequestOptions, function(response) {
      var body = ''

      response.on('data', function(chunk) {
        body += chunk
      })

      response.on('end', function() {
        if (body === 'CAPCHA_NOT_READY') {
          return
        }

        clearInterval(intervalId)

        var result = body.split('|')
        if (result[0] !== 'OK') {
          callback(result[0]) //error
        } else {
          callback(
            null,
            {
              id: captchaId,
              text: result[1]
            },
            invalid
          )
        }
        callback = function() {} // prevent the callback from being called more than once, if multiple https requests are open at the same time.
      })
    })
    request.on('error', function(e) {
      request.destroy()
      callback(e)
    })
    request.end()
  }, options.pollingInterval || defaultOptions.pollingInterval)
}

export const setApiKey = function(key) {
  apiKey = key
}

export const decode = function(base64, options, callback) {
  if (!callback) {
    callback = options
    options = defaultOptions
  }
  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData = {
    method: apiMethod,
    key: apiKey,
    soft_id: SOFT_ID,
    body: base64
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        options,
        function(error) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            decode(base64, this.options, callback)
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })

  request.write(postData)
  request.end()
}

export const decodeReCaptcha = function(
  captchaMethod,
  captcha,
  pageUrl,
  extraData,
  options,
  callback
) {
  if (!callback) {
    callback = options
    options = defaultOptions
  }
  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData = {
    method: captchaMethod,
    key: apiKey,
    soft_id: SOFT_ID,
    // googlekey: captcha,
    pageurl: pageUrl,
    ...extraData
  }
  if (captchaMethod === 'userrecaptcha') {
    postData.googlekey = captcha
  }
  if (captchaMethod === 'hcaptcha') {
    postData.sitekey = captcha
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        options,
        function(error) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            decodeReCaptcha(
              captchaMethod,
              captcha,
              pageUrl,
              extraData,
              this.options,
              callback
            )
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.write(postData)
  request.end()
}

export const decodeUrl = function(uri, options, callback) {
  if (!callback) {
    callback = options
    options = defaultOptions
  }

  var options = url.parse(uri)

  var request = https.request(options, function(response) {
    var body = ''
    response.setEncoding('base64')

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      decode(body, options, callback)
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.end()
}

export const solveRecaptchaFromHtml = function(html, options, callback) {
  if (!callback) {
    callback = options
    options = defaultOptions
  }
  var googleUrl = html.split('/challenge?k=')
  if (googleUrl.length < 2) return callback('No captcha found in html')
  googleUrl = googleUrl[1]
  googleUrl = googleUrl.split('"')[0]
  googleUrl = googleUrl.split("'")[0]
  googleUrl = 'https://www.google.com/recaptcha/api/challenge?k=' + googleUrl

  var httpsRequestOptions = url.parse(googleUrl)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''
    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var challengeArr = body.split("'")
      if (!challengeArr[1]) return callback('Parsing captcha failed')
      var challenge = challengeArr[1]
      if (challenge.length === 0) return callback('Parsing captcha failed')

      decodeUrl(
        'https://www.google.com/recaptcha/api/image?c=' + challenge,
        options,
        function(error, result, invalid) {
          if (result) {
            result.challenge = challenge
          }
          callback(error, result, invalid)
        }
      )
    })
  })
  request.end()
}

export const report = function(captchaId) {
  var reportUrl =
    apiResUrl +
    '?action=reportbad&soft_id=' +
    SOFT_ID +
    '&key=' +
    apiKey +
    '&id=' +
    captchaId
  var options = url.parse(reportUrl)

  var request = https.request(options, function(response) {
    // var body = ''
    // response.on('data', function(chunk) {
    //   body += chunk
    // })
    // response.on('end', function() {})
  })
  request.end()
}

export interface TurnstileOptions {
  sitekey: string
  pageurl: string
  action?: string
  data?: string
  pagedata?: string
}

export interface GeetestV4Options {
  captchaId: string
  pageurl: string
}

export interface GeetestOptions {
  gt: string
  challenge: string
  pageurl: string
  apiServer?: string
}

export interface ArkoseLabsOptions {
  publickey: string
  pageurl: string
  surl?: string
  data?: object
}

export interface AmazonWafOptions {
  sitekey: string
  pageurl: string
  iv?: string
  context?: string
}

export interface YandexOptions {
  sitekey: string
  pageurl: string
}

export interface CapyOptions {
  sitekey: string
  pageurl: string
  apiServer?: string
}

export interface LeminOptions {
  captchaId: string
  pageurl: string
  divId?: string
  apiServer?: string
}

export interface KeyCaptchaOptions {
  s_s_c_user_id: string
  s_s_c_session_id: string
  s_s_c_web_server_sign: string
  s_s_c_web_server_sign2: string
  pageurl: string
}

export interface NormalOptions {
  body: string
  pageurl: string
  textinstructions?: string
  imginstructions?: string
}

export const solveTurnstile = function(
  options: TurnstileOptions,
  pollingOptions: any,
  callback: (error: any, result?: { id: string; text: string }, invalid?: any) => void
) {
  if (!callback) {
    callback = pollingOptions
    pollingOptions = defaultOptions
  }

  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData: any = {
    method: 'turnstile',
    key: apiKey,
    soft_id: SOFT_ID,
    sitekey: options.sitekey,
    pageurl: options.pageurl
  }

  // Add optional parameters
  if (options.action) {
    postData.action = options.action
  }
  if (options.data) {
    postData.data = options.data
  }
  if (options.pagedata) {
    postData.pagedata = options.pagedata
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        pollingOptions,
        function(error: any) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            solveTurnstile(options, this.options, callback)
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.write(postData)
  request.end()
}

export const solveGeetestV4 = function(
  options: GeetestV4Options,
  pollingOptions: any,
  callback: (error: any, result?: { id: string; text: string }, invalid?: any) => void
) {
  if (!callback) {
    callback = pollingOptions
    pollingOptions = defaultOptions
  }

  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData: any = {
    method: 'geetestv4',
    key: apiKey,
    soft_id: SOFT_ID,
    captchaId: options.captchaId,
    pageurl: options.pageurl
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        pollingOptions,
        function(error: any) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            solveGeetestV4(options, this.options, callback)
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.write(postData)
  request.end()
}

export const solveArkoseLabs = function(
  options: ArkoseLabsOptions,
  pollingOptions: any,
  callback: (error: any, result?: { id: string; text: string }, invalid?: any) => void
) {
  if (!callback) {
    callback = pollingOptions
    pollingOptions = defaultOptions
  }

  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData: any = {
    method: 'funcaptcha',
    key: apiKey,
    soft_id: SOFT_ID,
    publickey: options.publickey,
    pageurl: options.pageurl
  }

  // Add optional parameters
  if (options.surl) {
    postData.surl = options.surl
  }
  if (options.data) {
    postData.data = typeof options.data === 'string'
      ? options.data
      : JSON.stringify(options.data)
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        pollingOptions,
        function(error: any) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            solveArkoseLabs(options, this.options, callback)
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.write(postData)
  request.end()
}

export const solveGeetest = function(
  options: GeetestOptions,
  pollingOptions: any,
  callback: (error: any, result?: { id: string; text: string }, invalid?: any) => void
) {
  if (!callback) {
    callback = pollingOptions
    pollingOptions = defaultOptions
  }

  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData: any = {
    method: 'geetest',
    key: apiKey,
    soft_id: SOFT_ID,
    gt: options.gt,
    challenge: options.challenge,
    pageurl: options.pageurl
  }

  // Add optional parameters
  if (options.apiServer) {
    postData.apiServer = options.apiServer
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        pollingOptions,
        function(error: any) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            solveGeetest(options, this.options, callback)
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.write(postData)
  request.end()
}

export const solveAmazonWaf = function(
  options: AmazonWafOptions,
  pollingOptions: any,
  callback: (error: any, result?: { id: string; text: string }, invalid?: any) => void
) {
  if (!callback) {
    callback = pollingOptions
    pollingOptions = defaultOptions
  }

  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData: any = {
    method: 'amazon_waf',
    key: apiKey,
    soft_id: SOFT_ID,
    sitekey: options.sitekey,
    pageurl: options.pageurl
  }

  // Add optional parameters
  if (options.iv) {
    postData.iv = options.iv
  }
  if (options.context) {
    postData.context = options.context
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        pollingOptions,
        function(error: any) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            solveAmazonWaf(options, this.options, callback)
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.write(postData)
  request.end()
}

export const solveYandex = function(
  options: YandexOptions,
  pollingOptions: any,
  callback: (error: any, result?: { id: string; text: string }, invalid?: any) => void
) {
  if (!callback) {
    callback = pollingOptions
    pollingOptions = defaultOptions
  }

  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData: any = {
    method: 'yandex',
    key: apiKey,
    soft_id: SOFT_ID,
    sitekey: options.sitekey,
    pageurl: options.pageurl
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        pollingOptions,
        function(error: any) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            solveYandex(options, this.options, callback)
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.write(postData)
  request.end()
}

export const solveLemin = function(
  options: LeminOptions,
  pollingOptions: any,
  callback: (error: any, result?: { id: string; text: string }, invalid?: any) => void
) {
  if (!callback) {
    callback = pollingOptions
    pollingOptions = defaultOptions
  }

  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData: any = {
    method: 'lemin',
    key: apiKey,
    soft_id: SOFT_ID,
    captchaId: options.captchaId,
    pageurl: options.pageurl
  }

  // Add optional parameters
  if (options.divId) {
    postData.divId = options.divId
  }
  if (options.apiServer) {
    postData.apiServer = options.apiServer
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        pollingOptions,
        function(error: any) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            solveLemin(options, this.options, callback)
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.write(postData)
  request.end()
}

export const solveCapy = function(
  options: CapyOptions,
  pollingOptions: any,
  callback: (error: any, result?: { id: string; text: string }, invalid?: any) => void
) {
  if (!callback) {
    callback = pollingOptions
    pollingOptions = defaultOptions
  }

  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData: any = {
    method: 'capy',
    key: apiKey,
    soft_id: SOFT_ID,
    sitekey: options.sitekey,
    pageurl: options.pageurl
  }

  // Add optional parameters
  if (options.apiServer) {
    postData.apiServer = options.apiServer
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        pollingOptions,
        function(error: any) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            solveCapy(options, this.options, callback)
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.write(postData)
  request.end()
}

export const solveKeyCaptcha = function(
  options: KeyCaptchaOptions,
  pollingOptions: any,
  callback: (error: any, result?: { id: string; text: string }, invalid?: any) => void
) {
  if (!callback) {
    callback = pollingOptions
    pollingOptions = defaultOptions
  }

  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData: any = {
    method: 'keycaptcha',
    key: apiKey,
    soft_id: SOFT_ID,
    s_s_c_user_id: options.s_s_c_user_id,
    s_s_c_session_id: options.s_s_c_session_id,
    s_s_c_web_server_sign: options.s_s_c_web_server_sign,
    s_s_c_web_server_sign2: options.s_s_c_web_server_sign2,
    pageurl: options.pageurl
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        pollingOptions,
        function(error: any) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            solveKeyCaptcha(options, this.options, callback)
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.write(postData)
  request.end()
}

export const solveNormal = function(
  options: NormalOptions,
  pollingOptions: any,
  callback: (error: any, result?: { id: string; text: string }, invalid?: any) => void
) {
  if (!callback) {
    callback = pollingOptions
    pollingOptions = defaultOptions
  }

  var httpsRequestOptions = url.parse(apiInUrl)
  httpsRequestOptions.method = 'POST'

  var postData: any = {
    method: 'base64',
    key: apiKey,
    soft_id: SOFT_ID,
    body: options.body,
    pageurl: options.pageurl
  }

  // Add optional parameters
  if (options.textinstructions) {
    postData.textinstructions = options.textinstructions
  }
  if (options.imginstructions) {
    postData.imginstructions = options.imginstructions
  }

  postData = querystring.stringify(postData)

  var request = https.request(httpsRequestOptions, function(response) {
    var body = ''

    response.on('data', function(chunk) {
      body += chunk
    })

    response.on('end', function() {
      var result = body.split('|')
      if (result[0] !== 'OK') {
        return callback(result[0])
      }

      pollCaptcha(
        result[1],
        pollingOptions,
        function(error: any) {
          var callbackToInitialCallback = callback

          report(this.captchaId)

          if (error) {
            return callbackToInitialCallback('CAPTCHA_FAILED')
          }

          if (!this.options.retries) {
            this.options.retries = defaultOptions.retries
          }
          if (this.options.retries > 1) {
            this.options.retries = this.options.retries - 1
            solveNormal(options, this.options, callback)
          } else {
            callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES')
          }
        },
        callback
      )
    })
  })
  request.on('error', function(e) {
    request.destroy()
    callback(e)
  })
  request.write(postData)
  request.end()
}
