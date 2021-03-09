//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const kList = Symbol('list')
const kWatch = Symbol('watch')

class ListWatcher {
  constructor (listFunc, watchFunc, { group, version, names }, query) {
    this[kList] = listFunc
    this[kWatch] = watchFunc
    Object.assign(this, { group, version, names })
    this.searchParams = new URLSearchParams(query)
  }

  setAbortSignal (signal) {
    Object.defineProperty(this, 'signal', { value: signal })
  }

  mergeSearchParams (query = {}) {
    const searchParams = new URLSearchParams(this.searchParams)
    for (const [key, value] of Object.entries(query)) {
      searchParams.set(key, value)
    }
    return searchParams
  }

  watch (query) {
    const searchParams = this.mergeSearchParams(query)
    const options = { searchParams }
    if (this.signal) {
      options.signal = this.signal
    }
    return this[kWatch](options)
  }

  list (query) {
    const searchParams = this.mergeSearchParams(query)
    const options = { searchParams }
    return this[kList](options)
  }
}

module.exports = ListWatcher
