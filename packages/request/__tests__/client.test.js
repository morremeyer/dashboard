//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const http2 = require('http2')
const createError = require('http-errors')
const { globalLogger: logger } = require('@gardener-dashboard/logger')
const { Client, extend, isHttpError, createHttpError } = require('../lib')
const { NotFound } = createError
const {
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_AUTHORITY,
  HTTP2_HEADER_SCHEME,
  HTTP2_HEADER_PATH,
  HTTP2_METHOD_GET,
  HTTP2_METHOD_POST,
  HTTP2_HEADER_STATUS
} = http2.constants

jest.useFakeTimers()

describe('Client', () => {
  const prefixUrl = 'https://127.0.0.1:31415/test'

  describe('#constructor', () => {
    it('should create a new object', () => {
      const client = new Client({ prefixUrl })
      expect(client).toBeInstanceOf(Client)
    })

    it('should throw a type error', () => {
      expect(() => new Client()).toThrowError(TypeError)
    })
  })

  describe('#executeHooks', () => {
    const message = 'Hook execution failed'

    it('should run all hooks', () => {
      const beforeRequestSpy = jest.fn()
      const afterResponseSpy = jest.fn(() => {
        throw new Error(message)
      })
      const client = new Client({
        prefixUrl,
        hooks: {
          beforeRequest: [beforeRequestSpy],
          afterResponse: [afterResponseSpy]
        }
      })
      const args = ['a', 2, true]
      client.executeHooks('beforeRequest', ...args)
      expect(beforeRequestSpy).toBeCalledTimes(1)
      expect(beforeRequestSpy.mock.calls[0]).toEqual(args)
      expect(afterResponseSpy).not.toBeCalled()
      client.executeHooks('afterResponse')
      expect(afterResponseSpy).toBeCalledTimes(1)
      expect(logger.error).toBeCalledTimes(1)
      expect(logger.error).lastCalledWith('Failed to execute "afterResponse" hooks', message)
    })
  })

  describe('#getRequestHeaders', () => {
    let client
    const xRequestId = '4711'
    const defaultRequestHeaders = {
      [HTTP2_HEADER_SCHEME]: 'https',
      [HTTP2_HEADER_AUTHORITY]: '127.0.0.1:31415',
      [HTTP2_HEADER_METHOD]: HTTP2_METHOD_GET,
      [HTTP2_HEADER_PATH]: '/test',
      'x-request-id': xRequestId
    }

    beforeEach(() => {
      client = new Client({
        prefixUrl,
        headers: {
          'X-Request-Id': xRequestId
        }
      })
    })

    it('should return request header defaults', () => {
      expect(client.getRequestHeaders()).toEqual({
        ...defaultRequestHeaders
      })
    })

    it('should return request headers with absolute path', () => {
      expect(client.getRequestHeaders('/absolute/path')).toEqual({
        ...defaultRequestHeaders,
        [HTTP2_HEADER_PATH]: '/absolute/path'
      })
    })

    it('should return request headers with relative path', () => {
      expect(client.getRequestHeaders('relative/path')).toEqual({
        ...defaultRequestHeaders,
        [HTTP2_HEADER_PATH]: '/test/relative/path'
      })
    })

    it('should return request headers with search params', () => {
      const searchParams = new URLSearchParams({ foo: 'bar' })
      const search = '?' + searchParams
      expect(client.getRequestHeaders('path', {
        method: 'post',
        searchParams
      })).toEqual({
        ...defaultRequestHeaders,
        [HTTP2_HEADER_METHOD]: HTTP2_METHOD_POST,
        [HTTP2_HEADER_PATH]: '/test/path' + search
      })
    })

    it('should return request headers with query params', () => {
      const query = { foo: 'bar' }
      const search = '?' + new URLSearchParams(query)
      expect(client.getRequestHeaders('path', {
        searchParams: { foo: 'bar' }
      })).toEqual({
        ...defaultRequestHeaders,
        [HTTP2_HEADER_PATH]: '/test/path' + search
      })
    })
  })

  describe('#getResponseHeaders', () => {
    const responseHeaders = {
      [HTTP2_HEADER_STATUS]: 200
    }
    let client
    let stream

    beforeEach(() => {
      client = new Client({
        prefixUrl
      })
      stream = { once: jest.fn() }
    })

    it('should return the response headers with the default timeout', async () => {
      const result = client.getResponseHeaders(stream)
      expect(setTimeout).toBeCalledTimes(1)
      expect(setTimeout.mock.calls).toEqual([
        [expect.any(Function), client.responseTimeout]
      ])
      expect(stream.once).toBeCalledTimes(1)
      expect(stream.once.mock.calls).toEqual([
        ['response', expect.any(Function)]
      ])
      const onResponse = stream.once.mock.calls[0][1]
      onResponse.call(stream, responseHeaders)
      await expect(result).resolves.toEqual(responseHeaders)
    })

    it('should return with a timeout error', async () => {
      const result = client.getResponseHeaders(stream)
      jest.runAllTimers()
      await expect(result).rejects.toMatchObject({
        name: 'TimeoutError',
        code: 'ETIMEDOUT',
        message: expect.stringMatching(/Timeout awaiting "response" for \d+ ms/)
      })
    })
  })

  describe('#stream', () => {
    it('should successfully return a response', async () => {
      const client = new Client({ prefixUrl })
      const statusCode = 200
      const response = {
        statusCode
      }
      client.fetch = jest.fn().mockResolvedValue(response)
      await expect(client.stream()).resolves.toBe(response)
    })

    it('should throw a NotFound error', async () => {
      const client = new Client({ prefixUrl })
      const statusCode = 404
      const headers = {
        [HTTP2_HEADER_STATUS]: statusCode
      }
      const body = 'body'
      const response = {
        headers,
        statusCode,
        body: jest.fn().mockResolvedValue(body)
      }
      client.fetch = jest.fn().mockResolvedValue(response)
      await expect(client.stream()).rejects.toEqual(expect.objectContaining({
        name: 'NotFoundError',
        headers,
        statusCode,
        body
      }))
    })
  })

  describe('#defaults', () => {
    it('should return the default options', () => {
      const foo = 'bar'
      const options = { prefixUrl, foo }
      const client = new Client(options)
      expect(client.defaults.options).toEqual(options)
    })
  })

  describe('#extend', () => {
    it('should create a http client', () => {
      const client = extend({ prefixUrl })
      expect(client).toBeInstanceOf(Client)
    })
  })

  describe('#isHttpError', () => {
    it('should check if an error is a HTTP error', () => {
      expect(isHttpError(new Error('message'))).toBe(false)
      expect(isHttpError(createError(404))).toBe(true)
      expect(isHttpError(createError(404), 404)).toBe(true)
      expect(isHttpError(createError(404), 410)).toBe(false)
      expect(isHttpError(createError(404), [410, 404])).toBe(true)
      expect(isHttpError(createError(404), [401, 403])).toBe(false)
    })
  })

  describe('#createHttpError', () => {
    it('should create different HTTP errors', () => {
      const error = createHttpError({ statusCode: 404 })
      expect(error).toMatchObject({
        statusCode: 404,
        statusMessage: 'Not Found',
        message: 'Response code 404 (Not Found)'
      })
    })
  })
})
