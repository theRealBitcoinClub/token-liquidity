/*
  Liquidity app for SLP BCH tokens inspired by Bancors whitepaper
*/

'use strict'

// const lib = require('../src/lib/token-util.js')
// const got = require('got')

// Instantiate the JWT handling library for FullStack.cash.
const JwtLib = require('jwt-bch-lib')
const jwtLib = new JwtLib({
  // Overwrite default values with the values in the config file.
  server: 'https://auth.fullstack.cash',
  login: process.env.FULLSTACKLOGIN,
  password: process.env.FULLSTACKPASS
})

const SLP = require('../src/lib/slp')
let slp = new SLP()

const BCH = require('../src/lib/bch')
let bch = new BCH()

const { default: PQueue } = require('p-queue')
const queue = new PQueue({ concurrency: 1 })

// App utility functions library.
const TLUtils = require('../src/lib/util')
const tlUtil = new TLUtils()

// const Transactions = require('../src/lib/transactions')
// const txs = new Transactions()

const TokenLiquidity = require('../src/lib/token-liquidity')
const lib = new TokenLiquidity()

// Add the queue to the token-liquidity library
lib.queue = queue

const config = require('../config')
config.bchBalance = config.BCH_QTY_ORIGINAL
config.tokenBalance = config.TOKENS_QTY_ORIGINAL

// Winston logger
const wlogger = require('../src/lib/wlogger')

// Used for debugging.
const util = require('util')
util.inspect.defaultOptions = {
  showHidden: true,
  colors: true
}

// const BCH_ADDR1 = config.BCH_ADDR
// const TOKEN_ID = config.TOKEN_ID

const FIVE_MINUTES = 60000 * 5
const CONSOLIDATE_INTERVAL = 60000 * 100
const PRICE_UPDATE_INTERVAL = 60000 * 5
let timerHandle

let bchBalance
let tokenBalance

async function startTokenLiquidity () {
  // Read in the state file.
  try {
    const state = tlUtil.readState()
    console.log(`state: ${JSON.stringify(state, null, 2)}`)
  } catch (err) {
    wlogger.error('Could not read state.json file.')
  }

  // Get the JWT token needed to interact with the FullStack.cash API.
  await getJwt()
  bch = new BCH() // Reinitialize bchjs with the JWT token.
  slp = new SLP() // Reinitialize bchjs with the JWT token.

  // Get BCH balance.
  const addressInfo = await bch.getBCHBalance(config.BCH_ADDR, false)
  bchBalance = addressInfo.balance
  config.bchBalance = bchBalance
  wlogger.info(
    `BCH address ${config.BCH_ADDR} has a balance of ${bchBalance} BCH`
  )

  // console.log(`addressInfo: ${JSON.stringify(addressInfo, null, 2)}`)

  // Get all the TXIDs associated with this apps address. The app assumes all
  // these TXs have been processed.
  const seenTxs = addressInfo.txids
  // console.log(`seenTxs: ${JSON.stringify(seenTxs, null, 2)}`)

  // Get SLP token balance
  tokenBalance = await slp.getTokenBalance(config.SLP_ADDR)
  wlogger.info(
    `SLP token address ${config.SLP_ADDR} has a balance of: ${tokenBalance} PSF`
  )
  config.tokenBalance = tokenBalance

  // Get the BCH-USD exchange rate.
  const USDperBCH = await lib.getPrice()

  // Calculate exchange rate spot price.;
  const marketCap = USDperBCH * bchBalance
  console.log(`Market cap of BCH controlled by app: $${marketCap}`)
  const price = lib.getSpotPrice(bchBalance, USDperBCH)
  console.log(`Token spot price: $${price}`)

  // Kick off the processing loop. It periodically checks for new transactions
  // and reacts to them.
  timerHandle = setInterval(async function () {
    await processingLoop(seenTxs)
  }, 60000 * 2)

  // Interval to consolidate UTXOs (maintenance)
  setInterval(async function () {
    await bch.consolidateUtxos()
  }, CONSOLIDATE_INTERVAL)

  // Interval to update BCH spot price.
  setInterval(async function () {
    console.log('Updating BCH price.')
    await lib.getPrice()
  }, PRICE_UPDATE_INTERVAL)

  // Renew the JWT token every 24 hours
  setInterval(async function () {
    wlogger.info('Updating FullStack.cash JWT token')
    await getJwt()
    bch = new BCH() // Reinitialize bchjs with the JWT token.
    slp = new SLP() // Reinitialize bchjs with the JWT token.
  }, 60000 * 60 * 24)

  // Periodically write out status information to the log file. This ensures
  // the log file is created every day and the the /logapi route works.
  setInterval(function () {
    checkBalances()
  }, 60000 * 60) // 1 hour
}

// This 'processing loop' function is called periodically to identify and process
// any new transactions.
async function processingLoop (seenTxs) {
  try {
    const now = new Date()
    let outStr = `${now.toLocaleString()}: Checking transactions... `

    const obj = {
      seenTxs
    }

    const newTxids = await lib.detectNewTxs(obj)
    // console.log(`retObj: ${JSON.stringify(retObj, null, 2)}`)

    // If there are no new transactions, exit.
    if (newTxids.length === 0) {
      // Retrieve the balances from the blockchain.
      const retObj2 = await lib.getBlockchainBalances(config.BCH_ADDR)
      // console.log(`retObj2: ${JSON.stringify(retObj2, null, 2)}`)

      // Update the app balances.
      bchBalance = retObj2.bchBalance
      tokenBalance = retObj2.tokenBalance

      outStr += `...nothing new. BCH: ${bchBalance}, SLP: ${tokenBalance}`
      console.log(`${outStr}`)
      console.log(' ')

      return
    }

    // Add the new txids to the seenTxs array.
    newTxids.map(x => seenTxs.push(x.txid))

    outStr += `...${newTxids.length} new transactions found!`
    console.log(`${outStr}`)

    // process the new TX.
    for (let i = 0; i < newTxids.length; i++) {
      const obj = {
        txid: newTxids[i].txid,
        bchBalance,
        tokenBalance
      }

      // TODO: Instead of calling processTx(), call p-retry so that it will
      // retry processTx() several times if it errors out.
      console.log(' ')
      console.log(' ')
      console.log(
        `Processing new transaction with this data: ${JSON.stringify(
          obj,
          null,
          2
        )}`
      )

      clearInterval(timerHandle)

      // const result = await queue.pRetryProcessTx(obj)
      const result = await queue.add(() => lib.pRetryProcessTx(obj))
      console.log(`queue.size: ${queue.size}`)
      // console.log(`result: ${JSON.stringify(result, null, 2)}`)

      // If the app received tokens, send them to the 245 path.
      if (result.type === 'token') {
        // Wait before moving tokens, allows previous transaction to get picked
        // up by the network. Prevents race-condition.
        wlogger.debug('Waiting 2 minutes before moving tokens...')
        await sleep(60000 * 2)

        const obj = { tokenQty: result.tokenQty }
        await queue.add(() => slp.moveTokens(obj))
      }

      // Update the app balances. This temporarily updates the app balances until
      // processing is complete, at which time the app can get its balance from
      // an indexer.
      // CT 7/9/2020 - Added if statement to try and get around an issue I saw
      // in the logs where the values were coming back as undefined.
      if (result.bchBalance && result.tokenBalance) {
        bchBalance = result.bchBalance
        tokenBalance = result.tokenBalance
      } else {
        wlogger.error(
          `bchBalance or tokenBalance returned a non-true value: ${
            result.bchBalance
          }, ${result.tokenBalance}`
        )
      }
      console.log(`BCH: ${bchBalance}, SLP: ${tokenBalance}`)
      console.log(' ')

      // Sleep for 5 minutes to give Blockbook time to process the last transaction.
      // If result.txid === null, it's a self-generated TX, so we don't need to wait.
      if (result.txid !== null) {
        await waitForBlockbook(seenTxs)
      }

      timerHandle = setInterval(async function () {
        await processingLoop(seenTxs)
      }, 60000 * 2)
    }
  } catch (err) {
    wlogger.error('Error in token-liquidity.js.', err)
    console.log(' ')
    console.log('Err: ', err)
  }
}

// Sleep for 5 minutes to give Blockbook time to process the last transaction.
// Disables the processing loop while it waits.
async function waitForBlockbook (seenTxs) {
  const now = new Date()
  wlogger.info(
    `${now.toLocaleString()}: Waiting 5 minutes before processing next transaction...`
  )

  // clearInterval(timerHandle)
  await sleep(FIVE_MINUTES)
  console.log('...continuing processing.')
}

// Get's a JWT token from FullStack.cash.
// This code based on the jwt-bch-demo:
// https://github.com/Permissionless-Software-Foundation/jwt-bch-demo
async function getJwt () {
  try {
    // Log into the auth server.
    await jwtLib.register()

    let apiToken = jwtLib.userData.apiToken

    // Ensure the JWT token is valid to use.
    const isValid = await jwtLib.validateApiToken()

    // Get a new token with the same API level, if the existing token is not
    // valid (probably expired).
    if (!isValid.isValid) {
      apiToken = await jwtLib.getApiToken(jwtLib.userData.apiLevel)
      wlogger.info('The JWT token was not valid. Retrieved new JWT token.\n')
    } else {
      wlogger.info('JWT token is valid.\n')
    }

    // Set the environment variable.
    process.env.BCHJSTOKEN = apiToken
  } catch (err) {
    wlogger.error('Error in token-liquidity.js/getJwt(): ', err)
    throw err
  }
}

// Called by a timer interval to create a timestamp and check balances.
async function checkBalances () {
  try {
    const state = tlUtil.readState()
    const effTokenBal = lib.getEffectiveTokenBalance(state.bchBalance)
    const realTokenBal = await slp.getTokenBalance()

    wlogger.info(
      `usdPerBCH: ${state.usdPerBCH}, ` +
        `BCH balance: ${state.bchBalance}, ` +
        `Actual token balance: ${realTokenBal}, ` +
        `Effective token balance: ${effTokenBal}`
    )
  } catch (err) {
    wlogger.error('Error in checkBalances(): ', err)
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  startTokenLiquidity
}
