var events = require('events')
var util = require('util')

var BIP39 = require('bip39')
var ccWallet = require('cc-wallet-core').Wallet
var CryptoJS = require('crypto-js')
var _ = require('lodash')
var store = require('store')
var delayed = require('delayed')
var moment = require('moment')

var AssetModels = require('./AssetModels')
var JsonFormatter = require('./JsonFormatter')
var cwpp = require('./cwpp')
var CWPPPaymentModel = require('./CWPPPaymentModel')


/**
 * @event WalletEngine#error
 * @param {Error}
 */

/**
 * @event WalletEngine#update
 */

/**
 * @class WalletEngine
 * @extends events.EventEmitter
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.testnet=false]
 * @param {string} [opts.network=Electrum] Available: Chain, Electrum
 * @param {string} [opts.blockchain=NaiveBlockchain] Available: NaiveBlockchain, VerifiedBlockchain
 * @param {number} [opts.storageSaveTimeout=1000]
 */
function WalletEngine(opts) {
  var self = this
  events.EventEmitter.call(self)

  opts = _.extend({
    testnet: false,
    network: 'Electrum',
    blockchain: 'NaiveBlockchain',
    storageSaveTimeout: 1000
  }, opts)

  self.setCallback(function () {})
  self._assetModels = null

  self._wallet = new ccWallet(opts)
  self._wallet.on('error', function (error) { self.emit('error', error) })

  if (self._wallet.isInitialized())
    self._initializeWalletEngine()
}

util.inherits(WalletEngine, events.EventEmitter)

/**
 * @return {Wallet}
 */
WalletEngine.prototype.getWallet = function () {
  return this._wallet
}

/**
 * @callback WalletEngine~setCallback
 */

/**
 * @param {WalletEngine~setCallback} callback
 */
WalletEngine.prototype.setCallback = function (callback) {
  this._updateCallback = delayed.debounce(callback, 100)
}

/**
 * @return {boolean}
 */
WalletEngine.prototype.isInitialized = function() {
  return !!this.getSeed() && !!this.getPin() && this._wallet.isInitialized()
}

/**
 * @param {string} mnemonic
 * @param {string} [password]
 * @param {string} pin
 * @throws {Error} If already initialized
 */
WalletEngine.prototype.initialize = function (mnemonic, password, pin) {
  this.setSeed(mnemonic, password)
  this._wallet.initialize(this.getSeed())
  this._initializeWalletEngine()
  this.setPin(pin)
  store.set('cc-wallet-engine__mnemonic', mnemonic)
  store.set('cc-wallet-engine__encryptedpin', this.getPinEncrypted())
}

/**
 */
WalletEngine.prototype._initializeWalletEngine = function () {
  var self = this

  self._assetModels = new AssetModels(self)
  self._assetModels.on('update', function () { self._updateCallback() })
  self._assetModels.on('error', function (error) { self.emit('error', error) })

  function subscribeCallback(error) {
    if (error !== null) { self.emit('error', error) }
  }
  self._wallet.on('newAddress', function () {
    self._wallet.subscribeAndSyncAllAddresses(subscribeCallback)
    self.emit('update')
  })
  self._wallet.subscribeAndSyncAllAddresses(subscribeCallback)
}

/**
 * @return {string}
 */
WalletEngine.prototype.generateMnemonic = BIP39.generateMnemonic

/**
 * TODO rename to more fitting isCurrentSeed
 * @param {string} mnemonic
 * @param {string} password
 * @return {boolean}
 */
WalletEngine.prototype.isCurrentMnemonic = function (mnemonic, password) {
  var seed = BIP39.mnemonicToSeedHex(mnemonic, password)
  return this._wallet.isCurrentSeed(seed)
}

/**
 * @return {boolean}
 */
WalletEngine.prototype.hasPin = function () {
  return !!this._pin
}

/**
 * @return {string}
 */
WalletEngine.prototype.getPin = function () {
  return this._pin
}

/**
 * @return {string}
 * @throws {Error} If seed es not set
 */
WalletEngine.prototype.getPinEncrypted = function () {
  if (!this.hasSeed())
    throw new Error('No seed set')

  var encrypted = CryptoJS.AES.encrypt(
    this._pin,
    this.getSeed(),
    { format: JsonFormatter }
  )

  return encrypted.toString()
}

/**
 * @param {strin} pin
 * @throws {Error} If seed es not set
 */
WalletEngine.prototype.setPinEncrypted = function (encryptedPin) {
  if (!this.hasSeed())
    throw new Error('No seed set')

  var decrypted = CryptoJS.AES.decrypt(
    encryptedPin,
    this.getSeed(),
    { format: JsonFormatter }
  )
  this._pin = decrypted.toString(CryptoJS.enc.Utf8)
}

/**
 * @param {strin} pin
 */
WalletEngine.prototype.setPin = function (pin) {
  this._pin = pin
}

/**
 * @return {boolean}
 */
WalletEngine.prototype.hasSeed = function () {
  return !!this.getSeed()
}

/**
 * @return {string}
 */
WalletEngine.prototype.getSeed = function () {
  return this._seed
}

/**
 * @param {string} mnemonic
 * @param {string} [password]
 * @throws {Error} If wrong seed
 */
WalletEngine.prototype.setSeed = function (mnemonic, password) {
  if (!!this._wallet.isInitialized() && !this.isCurrentMnemonic(mnemonic, password))
    throw new Error('Wrong seed')

  // only ever store see here and only in ram
  this._seed = BIP39.mnemonicToSeedHex(mnemonic, password)
}

/**
 * @return {string}
 */
WalletEngine.prototype.stored_mnemonic = function () {
  return store.get('cc-wallet-engine__mnemonic')
}

/**
 * @return {string}
 */
WalletEngine.prototype.stored_encryptedpin = function () {
  return store.get('cc-wallet-engine__encryptedpin')
}

/**
 * @return {boolean}
 */
WalletEngine.prototype.canResetSeed = function () {
  return (
    !this.hasSeed() && 
    !!this.stored_mnemonic() && 
    !!this.stored_encryptedpin() && 
    this._wallet.isInitialized()
  )
}

WalletEngine.prototype.resetSeed = function (password) {
  if (!this.canResetSeed())
    throw new Error('Cannot reset seed!')

  this.setSeed(this.stored_mnemonic(), password)
  this.setPinEncrypted(this.stored_encryptedpin())
}

/**
 * @return {AssetModel[]}
 */
WalletEngine.prototype.getAssetModels = function () {
  if (!this._wallet.isInitialized())
    return []

  return this._assetModels.getAssetModels()
}

/*
 * @param {string} assetId
 * @return {AssetModel}
 */
WalletEngine.prototype.getAssetModelById = function (assetId) {
  if (!this._wallet.isInitialized())
    throw new Error('not initialized')

  return this._assetModels.getAssetById(assetId)
}

/**
 */
WalletEngine.prototype.getHistory = function () {
  if (!this._wallet.isInitialized())
    return []

  return _.chain(this._assetModels.getAssetModels())
    .map(function (am) { return am.getHistory() })
    .flatten()
    .sortBy(function (hem) { return -moment(hem.getDate()).unix() })
    .value()
}

/**
 * @callback WalletEngine~makePaymentFromURI
 * @param {?Error} error
 * @param {CWPPPaymentModel} paymentModel
 */

/**
 * @param {string} uri
 * @param {WalletEngine~makePaymentFromURI} cb
 */
WalletEngine.prototype.makePaymentFromURI = function (uri, cb) {
  if (!this._wallet.isInitialized())
    return cb(new Error('not initialized'))

  var paymentModel
  function callback(error) {
    return error ? cb(error) : cb(null, paymentModel)
  }

  if (cwpp.is_cwpp_uri(uri)) {
    paymentModel = new CWPPPaymentModel(this, uri)
    if (this.hasSeed())
      paymentModel.setSeed(this.getSeed())

    return paymentModel.initialize(callback)
  }

  try {
    var asset = this._assetModels.getAssetForURI(uri)
    if (!asset)
      return cb(new Error('Asset not recognized'))

    paymentModel = asset.makePaymentFromURI(uri)
    if (this.hasSeed())
      paymentModel.setSeed(this.getSeed())

    callback(null)

  } catch (error) {
    callback(error)

  }
}

/**
 */
WalletEngine.prototype.removeListeners = function () {
  this.removeAllListeners()
  this._wallet.removeListeners()
  if (this.isInitialized()) { this._assetModels.removeListeners() }
}

/**
 */
WalletEngine.prototype.clearStorage = function () {
  this._wallet.clearStorage()
  store.remove('cc-wallet-engine__mnemonic')
  store.remove('cc-wallet-engine__encryptedpin')
}


module.exports = WalletEngine
