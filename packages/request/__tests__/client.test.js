//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const createError = require('http-errors')
const { Client, extend, isHttpError, createHttpError } = require('../lib')

describe('Client', function () {
  const prefixUrl = 'https://127.0.0.1:31415/test'

  describe('#constructor', function () {
    it('should create a new object', function () {
      const client = new Client({ prefixUrl })
      expect(client).toBeInstanceOf(Client)
    })

    it('should throw a type error', function () {
      expect(() => {
        // eslint-disable-next-line no-unused-vars
        const client = new Client()
      }).toThrowError(TypeError)
    })
  })

  describe('#defaults', function () {
    it('should return the default options', function () {
      const foo = 'bar'
      const options = { prefixUrl, foo }
      const client = new Client(options)
      expect(client.defaults.options).toEqual(options)
    })
  })

  describe('#extend', function () {
    it('should create a http client', function () {
      const client = extend({ prefixUrl })
      expect(client).toBeInstanceOf(Client)
    })
  })

  describe('#isHttpError', function () {
    it('should check if an error is a HTTP error', function () {
      expect(isHttpError(new Error('message'))).toBe(false)
      expect(isHttpError(createError(404))).toBe(true)
      expect(isHttpError(createError(404), 404)).toBe(true)
      expect(isHttpError(createError(404), 410)).toBe(false)
      expect(isHttpError(createError(404), [410, 404])).toBe(true)
      expect(isHttpError(createError(404), [401, 403])).toBe(false)
    })
  })

  describe('#createHttpError', function () {
    it('should create different HTTP errors', function () {
      const error = createHttpError({ statusCode: 404 })
      expect(error).toMatchObject({
        statusCode: 404,
        statusMessage: 'Not Found',
        message: 'Response code 404 (Not Found)'
      })
    })
  })
})
