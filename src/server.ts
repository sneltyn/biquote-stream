import 'module-alias/register'
import './pathAlias'

import {
  APP_NAME,
  BIQUOTE_HUB_URL,
  FOREX_PAIRS,
  NATS_SUBJECT_FOREX,
  NODE_ENV,
} from '@config/env'
import { logger } from '@config/logger'
import { nats } from '@config/nats'

import { BiquoteForex } from '@apps/sockets/biquote-forex'

let shuttingDown = false

async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`[shutdown] received ${signal}`)

  const timeout = setTimeout(() => {
    logger.error('[shutdown] timeout exceeded, forcing exit')
    process.exit(1)
  }, 10_000)
  timeout.unref()

  try {
    await BiquoteForex.shutdownAll()
    await nats.drain()
  } catch (err) {
    logger.error(`[shutdown] error: ${String(err)}`)
    code = 1
  } finally {
    clearTimeout(timeout)
    process.exit(code)
  }
}

async function run(): Promise<void> {
  nats.onUnexpectedClose((err) => {
    logger.error(
      `[nats] connection lost permanently, exiting for supervisor restart: ${String(err)}`
    )
    void shutdown('nats-closed', 1)
  })

  await nats.connect()

  // One line stating the whole contract: everything about this service is
  // "which subject carries which vendor", and getting it wrong is silent.
  logger.info(
    `[server] ${APP_NAME} (${NODE_ENV}) → ${NATS_SUBJECT_FOREX} · ` +
      `${FOREX_PAIRS.length} symbol(s) · real bid/ask from ${BIQUOTE_HUB_URL}`
  )

  BiquoteForex.init()
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
process.on('uncaughtException', (err) => {
  logger.error(`[uncaughtException] ${err.stack ?? err.message}`)
  void shutdown('uncaughtException', 1)
})
process.on('unhandledRejection', (reason) => {
  logger.error(`[unhandledRejection] ${String(reason)}`)
})

void run().catch((err) => {
  logger.error(`[boot] failed to start: ${String(err)}`)
  void shutdown('boot-failure', 1)
})
