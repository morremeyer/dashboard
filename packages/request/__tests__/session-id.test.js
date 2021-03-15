//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const SessionId = require('../lib/SessionId')

describe('SessionId', () => {
  const authority = 'https://foo.org'
  describe('#constructor', () => {
    it('should create an agent instance without any options', () => {
      const sessionId = new SessionId(authority)
      expect(sessionId.origin).toBe(authority)
      expect(sessionId.pathname).toBe('/99914b932bd37a50b983c5e7c90ae93b')
      expect(sessionId.getOptions()).toEqual({})
    })

    it('should create an agent instance with options', () => {
      const options = { b: 2, a: 1 }
      const sessionId = new SessionId(authority, options)
      expect(sessionId.origin).toBe(authority)
      expect(sessionId.pathname).toBe('/608de49a4600dbb5b173492759792e4a')
      expect(sessionId.getOptions()).toEqual(options)
    })

    it('should create an agent instance with id', () => {
      const options = { c: undefined, b: 2, d: null, id: '1', a: 1 }
      const sessionId = new SessionId(authority, options)
      expect(sessionId.origin).toBe(authority)
      expect(sessionId.pathname).toBe('/608de49a4600dbb5b173492759792e4a/1')
      expect(sessionId.getOptions()).toEqual(options)
    })

    it('should do it', () => {
      const fn = jest.fn()
        .mockImplementationOnce(() => 1)
        .mockReturnValueOnce(2)
        .mockImplementation(() => 3)
      expect(fn()).toBe(1)
      expect(fn()).toBe(2)
      expect(fn()).toBe(3)
    })
  })
})
