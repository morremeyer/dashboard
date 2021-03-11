//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const http2 = require('http2')
const createError = require('http-errors')
const { PassThrough } = require('stream')
const crypto = require('crypto')
const { Agent } = require('../lib')

const QuickLRU = require('quick-lru')

jest.useFakeTimers()

const { getOwnSymbolProperty } = fixtures.helper

class MockEmitter {
  constructor () {
    this.on = jest.fn()
    this.once = jest.fn()
  }
}

class MockResponse extends PassThrough {
  constructor ({ duration = 0, statusCode = 200 } = {}) {
    super({ objectMode: true })
    setTimeout(() => {
      if (statusCode >= 400) {
        this.destroy(createError(statusCode))
      } else {
        this.end({ ok: true })
      }
    }, duration)
  }
}

class MockSession extends MockEmitter {
  constructor ({ session: tlsSession } = {}) {
    super()
    this.remoteSettings = {
      maxConcurrentStreams: 100
    }
    const pingDuration = 1
    this.socket = new MockEmitter()
    this.destroy = jest.fn()
    this.close = jest.fn()
    this.ping = jest.fn(callback => setTimeout(() => callback(null, pingDuration)), pingDuration)
    this.request = jest.fn((headers, options = {}) => new MockResponse(options))
    this.setTimeout = jest.fn()
  }
}

describe('request', () => {
  describe('Agent', () => {
    let mockConnect

    beforeEach(() => {
      QuickLRU.mockClear()
      mockConnect = jest.spyOn(http2, 'connect').mockImplementation((...args) => new MockSession(...args))
    })

    describe('#constructor', () => {
      it('should create an agent instance with defaults', () => {
        const agent = new Agent()
        expect(agent).toMatchObject({
          timeout: 60000,
          connectTimeout: 5000,
          gracePeriod: 5000,
          maxOutstandingPings: 2,
          pingInterval: 30000
        })
        expect(QuickLRU).toBeCalledTimes(1)
        expect(QuickLRU.mock.calls[0]).toEqual([{ maxSize: 100 }])
        expect(agent.tlsSessionCache.size).toBe(0)
        expect(agent.sessionMap.size).toBe(0)
      })

      it('should create an agent instance without any defaults', () => {
        const agent = new Agent({
          maxCachedTlsSessions: 50,
          timeout: 30000,
          connectTimeout: 2500,
          gracePeriod: 2500,
          maxOutstandingPings: 1,
          pingInterval: 15000
        })
        expect(agent).toMatchObject({
          timeout: 30000,
          connectTimeout: 2500,
          gracePeriod: 2500,
          maxOutstandingPings: 1,
          pingInterval: 15000
        })
        expect(QuickLRU).toBeCalledTimes(1)
        expect(QuickLRU.mock.calls).toEqual([[{ maxSize: 50 }]])
        expect(agent.tlsSessionCache.size).toBe(0)
        expect(agent.sessionMap.size).toBe(0)
      })
    })

    describe('#getSession', () => {
      const tlsSession = crypto.randomBytes(16)

      let agent
      beforeEach(() => {
        agent = new Agent()
      })

      it('should create and close a session', () => {
        const url = new URL('https://example.org/foo')

        // create a new session
        const session = agent.getSession(url)
        const { socket } = session
        const semaphore = getOwnSymbolProperty(session, 'semaphore')
        const sid = getOwnSymbolProperty(session, 'sid')
        const setMaxConcurrencySpy = jest.spyOn(semaphore, 'maxConcurrency', 'set')

        expect(sid).toMatch(new RegExp(`^${url.origin}/[a-z0-9]{32}`))
        expect(mockConnect).toBeCalledTimes(1)
        expect(mockConnect.mock.calls[0]).toEqual([
          url.origin,
          expect.objectContaining({
            peerMaxConcurrentStreams: 100,
            settings: {
              enablePush: false
            },
            timeout: 60000,
            maxOutstandingPings: 2,
            servername: url.hostname
          })
        ])
        mockConnect.mockClear()

        // connect timeout
        expect(setTimeout).toBeCalledTimes(1)
        expect(setTimeout.mock.calls[0]).toEqual([
          expect.any(Function), agent.connectTimeout
        ])
        setTimeout.mockClear()

        // listening on 'session' events
        expect(socket.on).toBeCalledTimes(1)
        expect(socket.on.mock.calls).toEqual([
          ['session', expect.any(Function)]
        ])
        const onSession = socket.on.mock.calls[0][1]
        socket.on.mockClear()
        // call the 'connect' event listener
        onSession.call(socket, tlsSession)

        // listening on 'session' events
        expect(session.on).toBeCalledTimes(1)
        expect(session.on.mock.calls).toEqual([
          ['error', expect.any(Function)]
        ])
        session.on.mockClear()

        // listening on the 'connect' event
        expect(session.once).toBeCalledTimes(1)
        expect(session.once.mock.calls).toEqual([
          ['connect', expect.any(Function)]
        ])
        const onConnect = session.once.mock.calls[0][1]
        session.once.mockClear()
        // call the 'connect' event listener
        onConnect.call(session)

        // first update of maxConcurrency
        expect(setMaxConcurrencySpy).toBeCalledTimes(1)
        expect(setMaxConcurrencySpy.mock.calls[0]).toEqual([
          session.remoteSettings.maxConcurrentStreams
        ])
        setMaxConcurrencySpy.mockClear()

        // listening on the 'remoteSettings' and 'close' event
        expect(session.once).toBeCalledTimes(2)
        expect(session.once.mock.calls).toEqual([
          ['remoteSettings', expect.any(Function)],
          ['close', expect.any(Function)]
        ])
        const onRemoteSettings = session.once.mock.calls[0][1]
        const onClose = session.once.mock.calls[1][1]
        session.once.mockClear()
        session.remoteSettings.maxConcurrentStreams = 250
        // call the 'close' event listener
        onRemoteSettings.call(session)

        // second update of maxConcurrency
        expect(setMaxConcurrencySpy).toBeCalledTimes(1)
        expect(setMaxConcurrencySpy.mock.calls[0]).toEqual([
          session.remoteSettings.maxConcurrentStreams
        ])

        // reuse an existing session
        const secondSession = agent.getSession(url.origin)
        expect(secondSession).toBe(session)

        // close an existing session --> call the 'close' event listener
        onClose.call(session)

        // progress
        expect(setTimeout).toBeCalledTimes(1)
        expect(setTimeout.mock.calls[0]).toEqual([
          expect.any(Function), expect.toBeWithinRange(0, 100)
        ])
        jest.runAllTimers()

        // reuse an existing tls session
        const thirdSession = agent.getSession(url.origin)
        expect(thirdSession).not.toBe(session)
        expect(mockConnect).toBeCalledTimes(1)
        expect(mockConnect.mock.calls[0]).toEqual([
          url.origin,
          expect.objectContaining({
            session: tlsSession
          })
        ])
      })
    })
  })
})
