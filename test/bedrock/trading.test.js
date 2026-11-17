/* eslint-env mocha */
// Offline test for the Bedrock trade window: bot.openVillager resolves with the window the villager opened, or null when
// none comes (never the window an earlier villager opened), and the window's close() closes the trade screen itself.
// Mock packets, no server. Both were seen live on a Bedrock Dedicated Server 1.26.60.
const assert = require('assert')
const { EventEmitter } = require('events')
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const registryLoader = require('prismarine-registry')
const injectTrading = require('../../lib/bedrock_plugins/trading')
const injectParity = require('../../lib/bedrock_plugins/parity')
const { bedrockTestedVersions } = require('../../lib/version')

// A bot whose villagers answer a click with a trade list, or, for one with no job, with nothing.
function makeBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  const sent = []
  bot._client = new EventEmitter()
  bot._client.queue = (name, params) => sent.push({ name, params })
  let windowId = 10
  bot.useOn = (entity) => {
    if (!entity.trades) return
    setImmediate(() => bot._client.emit('update_trade', {
      window_id: ++windowId,
      window_type: 'trading',
      villager_unique_id: BigInt(entity.id),
      display_name: entity.name,
      offers: { value: { Recipes: { value: { value: [] } } } }
    }))
  }
  injectTrading(bot)
  injectParity(bot)
  return { bot, sent }
}

// openVillager gives up after six seconds; the tests don't wait that long.
async function withShortTimeouts (fn) {
  const realSetTimeout = global.setTimeout
  global.setTimeout = (callback, ms, ...args) => realSetTimeout(callback, ms >= 6000 ? 10 : ms, ...args)
  try { return await fn() } finally { global.setTimeout = realSetTimeout }
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} trade window`, function () {
    const serializer = createSerializer(version)
    const farmer = { id: 7, name: 'Farmer', trades: true }
    const jobless = { id: 8, name: 'Villager', trades: false }

    it('openVillager resolves with the window this villager opened', async function () {
      const { bot } = makeBot(version)
      const window = await bot.openVillager(farmer)
      assert.ok(window)
      assert.strictEqual(window.villagerEntityId, 7)
      assert.strictEqual(bot.tradeWindow, window)
    })

    it('a villager that opens nothing resolves null, not the window an earlier villager opened', async function () {
      const { bot, sent } = makeBot(version)
      const first = await bot.openVillager(farmer)
      const second = await withShortTimeouts(() => bot.openVillager(jobless))
      assert.strictEqual(second, null, 'the farmer\'s trades are not this villager\'s')
      assert.strictEqual(bot.tradeWindow, null)
      const close = sent.find(p => p.name === 'container_close')
      assert.ok(close, 'the farmer\'s trade screen was closed before the next villager was clicked')
      assert.strictEqual(close.params.window_id, first.id)
    })

    it('close() closes the trade screen by its own id, and it is no longer the trade window', async function () {
      const { bot, sent } = makeBot(version)
      bot.currentWindow = null // the trade screen never becomes the current window
      const window = await bot.openVillager(farmer)
      let closed = 0
      window.on('close', () => { closed++ })
      window.close()
      window.close() // once is enough
      const closes = sent.filter(p => p.name === 'container_close')
      assert.strictEqual(closes.length, 1)
      assert.deepStrictEqual(closes[0].params, { window_id: window.id, window_type: 'trading', server: false })
      assert.doesNotThrow(() => serializer.createPacketBuffer(closes[0]), 'container_close must serialize')
      assert.strictEqual(bot.tradeWindow, null)
      assert.strictEqual(closed, 1)
    })

    it('a trade screen the server closes is no longer the trade window', async function () {
      const { bot } = makeBot(version)
      const window = await bot.openVillager(farmer)
      let closed = false
      window.on('close', () => { closed = true })
      bot._client.emit('container_close', { window_id: window.id, window_type: 'trading', server: true })
      assert.strictEqual(bot.tradeWindow, null)
      assert.strictEqual(closed, true)
    })
  })
}
