//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const mock = jest.fn(() => {
  const map = new Map()
  map.spies = {
    set: jest.spyOn(map, 'set'),
    get: jest.spyOn(map, 'get'),
    delete: jest.spyOn(map, 'delete')
  }
  return map
})

module.exports = mock
