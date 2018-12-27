'use strict'

const { subscribeToRendererMessages } = require('./subscriptions')
const { createCore } = require('metronome-wallet-core')
const { ipcMain } = require('electron')
const logger = require('electron-log')
const settings = require('./settings')
const storage = require('./storage')

function startCore({ chain, core }, config) {
  const {
    emitter,
    events,
    api: coreApi
  } = core.start()

  events.push('create-wallet', 'open-wallets')

  let webContent = null
  let bestBlock = null

  function send(eventName, data) {
    if (!webContent) {
      if (eventName === 'eth-block') {
        bestBlock = data
      }
      return
    }
    webContent.send(eventName, Object.assign({}, data, { chain }))
  }

  events.forEach(event =>
    emitter.on(event, function (data) {
      send(event, data)
    })
  )

  emitter.on('open-wallets', function ({ address }) {
    storage.getSyncBlock()
      .then(function (from) {
        send('transactions-scan-started', { data: {} })
        logger.warn('From: ', from)
        coreApi.explorer.syncTransactions(from, address)
          .then(storage.setSyncBlock)
          .then(function () {
            send('transactions-scan-finished', { data: {} })
            emitter.on('eth-block', function ({ number }) {
              storage.setSyncBlock(number)
                .catch(function (err) {
                  logger.warn('Could not save new synced block', err)
                })
            })
          })
          .catch(function (err) {
            logger.warn('Could not sync transactions/events', err.stack)
            send('transactions-scan-finished', { data: {} })
          })
      })
  })

  emitter.on('wallet-error', err => logger.warn(err.message))

  ipcMain.on('ui-ready', function (e, args) {
    webContent = e.sender
    webContent.on('destroyed', function () {
      webContent = null
    })

    if (bestBlock) {
      send('eth-block', bestBlock)
    }
    const onboardingComplete = !!settings.getPasswordHash()
    storage.getState().then(function (persistedState) {
      send('ui-ready', Object.assign({}, args, {
        data: {
          onboardingComplete,
          persistedState: persistedState || {},
          config
        }
      }))
    })
  })

  ipcMain.on('ui-unload', function () {
    webContent = null
  })

  subscribeToRendererMessages(emitter, coreApi)
}

function createClient(config) {
  settings.presetDefaults()
  settings.attachSync(ipcMain)

  ipcMain.on('log.error', function (_, args) {
    logger.error(args.message)
  })

  const cores = config.enabledChains.map(chainName => ({
    chain: chainName,
    core: createCore(
      Object.assign({}, config.chains[chainName], config)
    )
  }))

  cores.forEach(core => startCore(core, config))
}

module.exports = { createClient }
