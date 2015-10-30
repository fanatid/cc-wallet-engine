var inherits = require('util').inherits

var request = require('request')
var _ = require('lodash')
var Q = require('q')
var cclib = require('cc-wallet-core').cclib
var OperationalTx = require('cc-wallet-core').tx.OperationalTx
var RawTx = require('cc-wallet-core').tx.RawTx

var PaymentModel = require('./PaymentModel')
var cwpp = require('./cwpp')
var errors = require('./errors')


/**
 * @class CWPPPaymentModel
 * @extends PaymentModel
 *
 * @param {WalletEngine} walletEngine
 * @param {string} paymentURI
 */
function CWPPPaymentModel(walletEngine, paymentURI) {
  PaymentModel.call(this)

  this.walletEngine = walletEngine
  this.paymentURI = paymentURI
  this.state = 'non-initialized'
  this.payreq = null
}

inherits(CWPPPaymentModel, PaymentModel)

/**
 * @callback CWPPPaymentModel~initializeCallback
 * @param {?Error} error
 */

/**
 * @param {CWPPPaymentModel~initializeCallback} cb
 * @throws {Error}
 */
CWPPPaymentModel.prototype.initialize = function (cb) {
  var self = this

  var requestOpts = {
    method: 'GET',
    uri: cwpp.requestURL(self.paymentURI),
    json: true
  }

  Q.nfcall(request, requestOpts).spread(function (response, body) {
    if (response.statusCode !== 200) {
      throw new errors.RequestError('CWPPPaymentModel: ' + response.statusMessage)
    }

    var cwppURIHash = cwpp.getURIHash(self.paymentURI)

    if ((cwpp.hashMessage_long(body) !== cwppURIHash) &&
        (cwpp.hashMessage_short(body) !== cwppURIHash)) {
      throw new errors.PaymentError('PaymentRequest hash mismatch')
    }

    self.payreq = body

    if (self.payreq.acceptedMethods.cinputs !== true) {
      throw new errors.PaymentError('incompatible payment method. upgrade required?')
    }

    var assetId = self.payreq.assetId
    self.assetModel = self.walletEngine.getAssetModelById(assetId)
    self.sourceAssetModel = self.assetModel // use the same source
    if (!self.assetModel) {
      throw new errors.AssetNotRecognizedError('CWPPPaymentModel.initialize')
    }

    // TODO this is hackish, move this to AssetDefinition
    var colorAddress = assetId + '@' + self.payreq.address

    self.recipients = [{
      address: colorAddress,
      amount: self.payreq.value && self.assetModel.getAssetDefinition().formatValue(self.payreq.value)
    }]
    self.state = 'fresh'

  }).done(function () { cb(null) }, function (error) { cb(error) })
}

/**
 * @throws {NotImplementedError}
 */
CWPPPaymentModel.prototype.addRecipient = function () {
  throw new errors.NotImplementedError('CWPPPaymentModel.addRecipient')
}

CWPPPaymentModel.prototype.setSourceAsset = function (am) {
  this.sourceAssetModel = am
}

function getColorDef(am) {
  var ad = am.getAssetDefinition()
  return ad.getColorSet().getColorDefinitions()[0]
}

/**
 * @callback CWPPPaymentModel~selectCoinsCallback
 * @param {?Error} error
 * @param {external:cc-wallet-core.Coin~RawCoin[]} cinputs
 * @param {?{address: string, value: number}} change
 * @param {external:cc-wallet-core.cclib.ColorDefinition} colordef
 */

/**
 * @param {CWPPPaymentModel~selectCoinsCallback} cb
 */
CWPPPaymentModel.prototype.selectCoins = function (cb) {
  var self = this

  var assetdef = self.sourceAssetModel.getAssetDefinition()
  var colordef = getColorDef(self.sourceAssetModel)
  var neededColorValue = new cclib.ColorValue(colordef, self.payreq.value)

  var opTx = new OperationalTx(self.walletEngine.getWallet())
  opTx.selectCoins(neededColorValue, null, function (error, coins, colorValue) {
    if (error) {
      return cb(error)
    }

    var cinputs = coins.map(function (coin) { return coin.toRawCoin() })
    var change = null
    if (colorValue.getValue() > self.payreq.value) {
      change = {
        address: opTx.getChangeAddress(colordef),
        value: colorValue.getValue() - self.payreq.value
      }
    }

    cb(null, cinputs, change, colordef)
  })
}

/**
 * @param {RawTx} rawTx
 * @param {external:cc-wallet-core.Coin~RawCoin[]} cinputs
 * @param {?{address: string, value: number}} change
 * @param {external:cc-wallet-core.cclib.ColorDefinition} colordef
 * @return {Q.Promise}
 */
CWPPPaymentModel.prototype._checkRawTx = function (rawTx, cinputs, change, colordef) {
  var self = this
  var wallet = self.walletEngine.getWallet()

  return Q.fcall(function () {
    // check inputs
    var tx = rawTx.toTransaction(true)
    var txInputs = _.zipObject(tx.ins.map(function (input, index) {
      var txId = Array.prototype.reverse.call(new Buffer(input.hash)).toString('hex')
      return [txId + input.index, index]
    }))
    var indexes = _.chain(txInputs)
      .keys()
      .difference(cinputs.map(function (input) {
        return input.txId + input.outIndex
      }))
      .map(function (key) { return txInputs[key] })
      .value()

    if (indexes.length === 0) {
      return
    }

    return Q.ninvoke(rawTx, 'getInputAddresses', wallet, indexes).then(function (txAddresses) {
      if (_.intersection(txAddresses, wallet.getAllAddresses()).length > 0) {
        throw new errors.CWPPWrongTxError('Wrong inputs')
      }
    })

  }).then(function () {
    // check outputs
    var fromBase58Check = cclib.bitcoin.Address.fromBase58Check

    var value = self.payreq.value
    if (self.payreq.fee && self.payreq.fee > 0) {
      value -= self.payreq.fee
    }

    var targets = [{address: self.payreq.address,
                    value: value}]
    if (change !== null) {
      targets.push({
        address: change.address,
        value: change.value
      })
    }

    var colorTargets = targets.map(function (recipient) {
      var script = fromBase58Check(recipient.address).toOutputScript().toHex()
      var amount = recipient.value
      var colorValue = new cclib.ColorValue(colordef, amount)
      return new cclib.ColorTarget(script, colorValue)
    })

    return Q.ninvoke(rawTx, 'satisfiesTargets', wallet, colorTargets, true).then(function (isSatisfied) {
      if (!isSatisfied) {
        throw new errors.CWPPWrongTxError('Wrong outputs')
      }
    })
  })
}

/**
 * @callback CWPPPaymentModel~sendCallback
 * @param {?Error} error
 */

/**
 * @param {CWPPPaymentModel~sendCallback} cb
 */
CWPPPaymentModel.prototype.send = function (cb) {
  var self = this

  if (self.readOnly) {
    return cb(new errors.PaymentAlreadyCommitedError())
  }

  if (self.state !== 'fresh') {
    return cb(new errors.PaymentWasNotProperlyInitializedError())
  }

  if (self.recipients.length === 0) {
    return cb(new errors.ZeroArrayLengthError('CWPPPaymentModel.send: recipients list is empty'))
  }

  if (self.seed === null) {
    return cb(new errors.MnemonicIsUndefinedError('CWPPPaymentModel.send'))
  }

  self.readOnly = true
  self.status = 'sending'

  /**
   * @param {Object} message
   * @return {Q.Promise<Object>}
   */
  function cwppProcess(message) {
    var requestOpts = {
      method: 'POST',
      uri: cwpp.processURL(self.paymentURI),
      body: JSON.stringify(message),
      json: true
    }
    return Q.nfcall(request, requestOpts).spread(function (response, body) {
      if (response.statusCode !== 200) {
        var error = response.statusMessage
        if (_.isObject(body) && !_.isUndefined(body.error)) {
          error = body.error
        }

        throw new errors.RequestError('CWPPPaymentModel: ' + error)
      }

      return body
    })
  }

  var wallet = self.walletEngine.getWallet()
  var out_colordef = getColorDef(self.assetModel)
  console.log('CWPP: selectCoins')
  Q.ninvoke(self, 'selectCoins').spread(function (cinputs, change, in_colordef) {
    // service build transaction
    console.log('CWPP: sending inputs')
    var msg = cwpp.make_cinputs_proc_req_1(in_colordef.getDesc(), cinputs, change)
    return cwppProcess(msg).then(function (response) {
      console.log('CWPP: check tx')
      var rawTx = RawTx.fromHex(response.tx_data)      
      // check inputs and outputs      
      return self._checkRawTx(rawTx, cinputs, change, out_colordef).then(function () {
        return rawTx
      })

    }).then(function (rawTx) {
      console.log('CWPP: sign tx')
      // we signing transaction
      var tx = rawTx.toTransaction(true)
      var txInputs = _.zipObject(tx.ins.map(function (input, index) {
        var txId = Array.prototype.reverse.call(new Buffer(input.hash)).toString('hex')
        return [txId + input.index, index]
      }))
      var indexes = _.chain(cinputs)
        .map(function (input) { return txInputs[input.txId + input.outIndex] })
        .value()

      var opts = {seedHex: self.seed, signingOnly: indexes}
      return Q.ninvoke(wallet, 'transformTx', rawTx, 'partially-signed', opts)
    })

  }).then(function (tx) {
    console.log('CWPP: sending partially-signed transaction')
    // service signing transaction
    var msg = cwpp.make_cinputs_proc_req_2(tx.toHex(true))
    return cwppProcess(msg)

  }).then(function (response) {
    console.log('CWPP: sending fully signed transaction to the network')
    // build transaction and send
    var tx = RawTx.fromHex(response.tx_data).toTransaction()
    self.txId = tx.getId()
    return Q.ninvoke(wallet, 'sendTx', tx)
  }).done(
    function () {
      self.status = 'send'
      cb(null, self.txId)
    },
    function (error) {
      self.status = 'failed'
      cb(error)
    }
  )
}


module.exports = CWPPPaymentModel
