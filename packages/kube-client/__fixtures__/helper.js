//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

function getOwnSymbol (obj, description) {
  return Object.getOwnPropertySymbols(obj).find(symbol => symbol.description === description)
}

function getOwnSymbolProperty (obj, description) {
  return obj[getOwnSymbol(obj, description)]
}

function nextTick () {
  return new Promise(resolve => process.nextTick(resolve))
}

function delay (milliseconds = 1) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

module.exports = {
  getOwnSymbol,
  getOwnSymbolProperty,
  nextTick,
  delay
}
