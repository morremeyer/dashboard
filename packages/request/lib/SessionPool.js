//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const http2 = require('http2')
const net = require('net')
const { globalLogger: logger } = require('@gardener-dashboard/logger')
const Semaphore = require('./Semaphore')
const { TimeoutError, isAbortError } = require('./errors')

const {
  NGHTTP2_CANCEL
} = http2.constants

const kSemaphore = Symbol('semaphore')
const kTimestamp = Symbol('timestamp')
const kTimeoutId = Symbol('timeoutId')
const kIntervalId = Symbol('intervalId')

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

class SessionPool {
  constructor (id) {
    this.id = id
    this.sessions = new Set()
    this.tlsSession = undefined
    this.queue = []
  }

  get options () {
    return this.id.getOptions()
  }

  get pingInterval () {
    return this.options.pingInterval
  }

  get keepAliveTimeout () {
    return this.options.keepAliveTimeout
  }

  get connectTimeout () {
    return this.options.connectTimeout
  }

  get value () {
    let value = 0
    for (const { [kSemaphore]: semaphore } of this.sessions) {
      value += semaphore.value
    }
    return value
  }

  destroy () {
    this.tlsSession = undefined
    for (const session of this.sessions) {
      this.deleteSession(session)
    }
  }

  addTask (resolve, reject) {
    let settled = false
    const callback = (err, session) => {
      if (!settled) {
        settled = true
        clearTimeout(timeoutId)
        if (err) {
          reject(err)
        } else {
          resolve(session)
        }
      }
    }
    const timeoutId = setTimeout(() => {
      const index = this.queue.indexOf(callback)
      if (index > -1) {
        this.queue.splice(index, 1)
      }
      callback(new TimeoutError(`No session could be aquired within ${this.connectTimeout} ms`))
    }, this.connectTimeout)
    this.queue.push(callback)
  }

  acquire () {
    const ticket = new Promise((resolve, reject) => this.addTask(resolve, reject))
    this.dispatch()
    return ticket
  }

  async dispatch () {
    let scalingUp = false
    const scaleUp = async () => {
      if (!scalingUp) {
        scalingUp = true
        try {
          await this.createSession()
        } catch (err) {
          const callback = this.queue.shift()
          callback(err)
          const milliseconds = Math.floor((2 * Math.random() - 1) * 25) + 100
          await delay(milliseconds)
        } finally {
          scalingUp = false
          this.dispatch()
        }
      }
    }

    while (this.queue.length) {
      const session = this.find()
      if (!session) {
        scaleUp()
        break
      }
      const callback = this.queue.shift()
      const release = await session[kSemaphore].acquire()
      callback(null, [session, release])
    }
  }

  find () {
    const sessionList = Array.from(this.sessions)
    return sessionList
      // consider free sessions only
      .filter(({ [kSemaphore]: semaphore }) => {
        return semaphore.value > 0
      })
      // session with the highest load first
      .sort(({ [kSemaphore]: a }, { [kSemaphore]: b }) => {
        return a.value - b.value
      })
      .shift()
  }

  async request (headers, options) {
    const [session, release] = await this.acquire()
    clearTimeout(session[kTimeoutId])
    const stream = session.request(headers, options)
    stream.once('error', err => {
      if (!isAbortError(err)) {
        logger.error('An error occured during the processing of an Http2Stream: %s', err.message)
      }
    })
    stream.once('close', () => {
      release()
      if (session[kSemaphore].value >= session[kSemaphore].maxConcurrency) {
        this.setSessionTimeout(session)
      }
    })
    return stream
  }

  setSessionTimeout (session) {
    clearTimeout(session[kTimeoutId])
    const close = () => session.close()
    session[kTimeoutId] = setTimeout(close, this.keepAliveTimeout)
  }

  setSessionHeartbeat (session) {
    let canceled = false
    const cancel = err => {
      if (!canceled) {
        canceled = true
        logger.debug('Session -> canceled: %s', err.message)
        this.deleteSession(session, err, NGHTTP2_CANCEL)
      }
    }
    const ping = () => {
      session.ping(pong)
    }
    const pong = (err, duration) => {
      if (err) {
        cancel(err)
      } else {
        logger.trace('Session -> ping %d ms', Math.round(duration))
      }
    }
    session[kIntervalId] = setInterval(ping, this.pingInterval)
  }

  createSession () {
    const {
      origin,
      hostname
    } = this.id
    const {
      peerMaxConcurrentStreams,
      connectTimeout,
      keepAliveTimeout,
      pingInterval,
      ...options
    } = this.options
    const servername = !net.isIP(hostname) ? hostname : ''

    return new Promise((resolve, reject) => {
      const session = http2.connect(origin, {
        peerMaxConcurrentStreams,
        servername,
        ...options
      })
      session[kTimestamp] = Date.now()
      session[kSemaphore] = new Semaphore(peerMaxConcurrentStreams)
      // tls session can be used for resumption
      session.socket.once('session', session => {
        this.tlsSession = session
      })
      // update maxConcurrency of semaphore
      const setMaxConcurrency = () => {
        session[kSemaphore].maxConcurrency = session.remoteSettings.maxConcurrentStreams
      }
      // handle connect timeout
      const timeoutId = setTimeout(() => {
        logger.error('Session -> connect timed out')
        session.removeAllListeners('error')
        session.removeAllListeners('connect')
        session.destroy()
        reject(new TimeoutError('Session connect timed out'))
      }, connectTimeout)
      // handle connect error
      session.once('error', err => {
        logger.error('Session -> connect error: %s', err.message)
        session.removeAllListeners('connect')
        clearTimeout(timeoutId)
        this.tlsSession = undefined
        reject(err)
      })
      // handle connect
      session.once('connect', () => {
        logger.debug('Session -> connected after %d ms', Date.now() - session[kTimestamp])
        session.removeAllListeners('error')
        clearTimeout(timeoutId)
        setMaxConcurrency()
        session.once('remoteSettings', setMaxConcurrency)
        session.once('close', () => {
          logger.info('Session -> closed after %d ms', Date.now() - session[kTimestamp])
          this.deleteSession(session)
        })
        session.on('error', err => {
          logger.error('Session -> unexpected error: %s', err.message)
          this.tlsSession = undefined
        })
        this.setSessionTimeout(session)
        if (pingInterval) {
          this.setSessionHeartbeat(session)
        }
        this.addSession(session)
        resolve()
      })
    })
  }

  addSession (session) {
    this.sessions.add(session)
  }

  deleteSession (session, ...args) {
    // stop keep-alive timeout
    clearTimeout(session[kTimeoutId])
    session[kTimeoutId] = undefined
    // stop heartbeat interval
    clearInterval(session[kIntervalId])
    session[kIntervalId] = undefined
    // remove session
    this.sessions.delete(session)
    // destory session
    session.destroy(...args)
  }
}

module.exports = SessionPool
