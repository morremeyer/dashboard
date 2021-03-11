//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const { join } = require('path')
const http = require('http')
const http2 = require('http2')
const createError = require('http-errors')
const typeis = require('type-is')
const { globalLogger: logger } = require('@gardener-dashboard/logger')
const { globalAgent } = require('./Agent')

const {
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_AUTHORITY,
  HTTP2_HEADER_SCHEME,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_CONTENT_TYPE,
  HTTP2_HEADER_CONTENT_LENGTH,
  HTTP2_METHOD_GET,
  NGHTTP2_CANCEL
} = http2.constants

const kDefaults = Symbol('defaults')

const EOL = 10

class Client {
  constructor ({ prefixUrl, ...options } = {}) {
    if (!prefixUrl) {
      throw TypeError('prefixUrl is required')
    }
    this[kDefaults] = {
      options: {
        prefixUrl,
        ...options
      }
    }
  }

  get defaults () {
    return this[kDefaults]
  }

  get responseTimeout () {
    return this.defaults.options.responseTimeout || 15 * 1000
  }

  get baseUrl () {
    return new URL(this.defaults.options.prefixUrl)
  }

  getSession (options) {
    const origin = this.baseUrl.origin
    const { ca, rejectUnauthorized, key, cert, id } = this.defaults.options
    const defaultOptions = { ca, rejectUnauthorized, key, cert, id }
    return globalAgent.getSession(origin, Object.assign(defaultOptions, options))
  }

  executeHooks (name, ...args) {
    try {
      const hooks = this.defaults.options.hooks || {}
      if (Array.isArray(hooks[name])) {
        for (const hook of hooks[name]) {
          hook(...args)
        }
      }
    } catch (err) {
      logger.error(`Failed to execute "${name}" hooks`, err.message)
    }
  }

  getRequestHeaders (path = '', { method = HTTP2_METHOD_GET, searchParams, headers } = {}) {
    const url = this.baseUrl
    const [pathname, search = ''] = path.split(/\?/)
    if (pathname.startsWith('/')) {
      url.pathname = pathname
    } else {
      url.pathname = join(url.pathname, pathname)
    }
    if (!searchParams) {
      url.search = search
    } else if (searchParams instanceof URLSearchParams) {
      url.search = searchParams.toString()
    } else {
      url.search = new URLSearchParams(searchParams).toString()
    }
    const { normalizeHeaders } = this.constructor
    return Object.assign(
      {
        [HTTP2_HEADER_SCHEME]: url.protocol.replace(/:$/, ''),
        [HTTP2_HEADER_AUTHORITY]: url.host,
        [HTTP2_HEADER_METHOD]: method.toUpperCase(),
        [HTTP2_HEADER_PATH]: url.pathname + url.search
      },
      normalizeHeaders(this.defaults.options.headers),
      normalizeHeaders(headers)
    )
  }

  getResponseHeaders (stream, { threshold = this.responseTimeout } = {}) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const error = new Error(`Timeout awaiting "response" for ${threshold} ms`)
        error.name = 'TimeoutError'
        error.code = 'ETIMEDOUT'
        reject(error)
      }, threshold)
      stream.once('response', headers => {
        clearTimeout(timeoutId)
        resolve(headers)
      })
    })
  }

  async fetch (path, { method, searchParams, headers, body, signal, ...options } = {}) {
    headers = this.getRequestHeaders(path, {
      method,
      searchParams,
      headers
    })

    // beforeRequest hooks
    const requestOptions = {
      url: new URL(headers[HTTP2_HEADER_PATH], this.baseUrl.origin),
      method: headers[HTTP2_HEADER_METHOD],
      headers,
      body,
      ...options
    }
    this.executeHooks('beforeRequest', requestOptions)

    const stream = await this.getSession(options).request(headers, { signal })
    if (body) {
      stream.write(body)
    }
    stream.end()
    try {
      headers = await this.getResponseHeaders(stream, {
        timeout: options.responseTimeout
      })
    } catch (err) {
      stream.close(NGHTTP2_CANCEL)
      throw err
    }

    const { transformFactory } = this.constructor

    return {
      request: { options: requestOptions },
      headers,
      get statusCode () {
        return this.headers[HTTP2_HEADER_STATUS]
      },
      get ok () {
        return this.statusCode >= 200 && this.statusCode < 300
      },
      get redirected () {
        return this.statusCode >= 300 && this.statusCode < 400
      },
      get contentType () {
        return this.headers[HTTP2_HEADER_CONTENT_TYPE]
      },
      get contentLength () {
        return this.headers[HTTP2_HEADER_CONTENT_LENGTH]
      },
      get type () {
        return typeis.is(this.contentType, ['json', 'text'])
      },
      destroy (error) {
        stream.destroy(error)
      },
      async body () {
        let data = Buffer.from([])
        for await (const chunk of stream) {
          data = Buffer.concat([data, chunk], data.length + chunk.length)
        }
        switch (this.type) {
          case 'text':
            return data.toString('utf8')
          case 'json':
            return JSON.parse(data)
          default:
            return data
        }
      },
      async * [Symbol.asyncIterator] () {
        let data = Buffer.from([])
        const transform = transformFactory(this.type)
        for await (const chunk of stream) {
          data = Buffer.concat([data, chunk], data.length + chunk.length)
          let index
          while ((index = data.indexOf(EOL)) !== -1) {
            yield transform(data.slice(0, index))
            data = data.slice(index + 1)
          }
        }
        if (data && data.length) {
          yield transform(data)
        }
      }
    }
  }

  async stream (path, options) {
    const response = await this.fetch(path, options)
    const statusCode = response.statusCode
    if (statusCode >= 400) {
      throw this.constructor.createHttpError({
        statusCode,
        headers: response.headers,
        body: await response.body()
      })
    }
    return response
  }

  async request (path, { headers = {}, body, json, ...options } = {}) {
    headers = this.constructor.normalizeHeaders(headers)
    if (json) {
      body = JSON.stringify(json)
      if (!headers[HTTP2_HEADER_CONTENT_TYPE]) {
        headers[HTTP2_HEADER_CONTENT_TYPE] = 'application/json'
      }
    }
    const response = await this.fetch(path, { headers, body, ...options })
    const statusCode = response.statusCode
    headers = response.headers
    body = await response.body()

    // afterResponse hooks
    const responseOptions = {
      headers,
      httpVersion: '2',
      statusCode,
      statusMessage: http.STATUS_CODES[statusCode],
      body,
      request: response.request
    }
    this.executeHooks('afterResponse', responseOptions)

    if (statusCode >= 400) {
      throw this.constructor.createHttpError({
        statusCode,
        headers,
        body
      })
    }
    return body
  }

  static normalizeHeaders (headers = {}) {
    const normalizeHeaders = {}
    for (const [key, value] of Object.entries(headers)) {
      normalizeHeaders[key.toLowerCase()] = value
    }
    return normalizeHeaders
  }

  static transformFactory (type) {
    switch (type) {
      case 'text':
        return data => data.toString('utf8')
      case 'json':
        return data => {
          try {
            return JSON.parse(data)
          } catch (err) {
            return err
          }
        }
      default:
        return data => data
    }
  }

  static createHttpError ({ statusCode, statusMessage = http.STATUS_CODES[statusCode], response, headers, body }) {
    const properties = { statusMessage }
    if (headers) {
      properties.headers = { ...headers }
    }
    if (body) {
      properties.body = body
    }
    if (response) {
      properties.response = response
    }
    const message = body && body.message
      ? body.message
      : `Response code ${statusCode} (${statusMessage})`
    return createError(statusCode, message, properties)
  }

  static isHttpError (err, expectedStatusCode) {
    if (!createError.isHttpError(err)) {
      return false
    }
    if (expectedStatusCode) {
      if (Array.isArray(expectedStatusCode)) {
        return expectedStatusCode.indexOf(err.statusCode) !== -1
      }
      return expectedStatusCode === err.statusCode
    }
    return true
  }

  static extend (options) {
    return new Client(options)
  }
}

module.exports = Client
