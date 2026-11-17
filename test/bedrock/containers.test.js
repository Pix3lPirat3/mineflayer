/* eslint-env mocha */
// Offline behaviour test for the Bedrock containers plugin: container_open sets bot.currentWindow, inventory_content
// for that window fills its slots, container_set_data records a property, and container_close (or bot.closeWindow)
// clears it and fires windowClose. Mock packets, no server. Live-verified separately: place a chest, open it (27
// slots), close it.
const assert = require('assert')
const { EventEmitter } = require('events')
const injectContainers = require('../../lib/bedrock_plugins/containers')
const { bedrockTestedVersions } = require('../../lib/version')

function makeBot () {
  const bot = new EventEmitter()
  const sent = []
  bot._client = new EventEmitter()
  bot._client.queue = (name, params) => sent.push({ name, params })
  bot._bedrockItemFromNotch = (it) => (it && it.network_id ? { name: 'stone', count: it.count } : null)
  injectContainers(bot)
  return { bot, sent }
}

// makeBot with the game data the plugin loads prismarine-windows from.
function makeBotFor (version) {
  const bot = new EventEmitter()
  const sent = []
  bot.registry = require('prismarine-registry')('bedrock_' + version)
  const slots = new Array(46).fill(null)
  bot.inventory = Object.assign(new EventEmitter(), { slots, items: () => slots.filter(Boolean), updateSlot: (i, item) => { slots[i] = item } })
  bot._client = new EventEmitter()
  bot._client.queue = (name, params) => sent.push({ name, params })
  bot._bedrockItemFromNotch = () => null
  injectContainers(bot)
  return { bot, sent }
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} containers plugin`, function () {
    it('opens, fills, records a property, and closes a container', function () {
      const { bot } = makeBot()
      let opened = null
      let filled = 0
      let closed = false
      bot.on('windowOpen', w => { opened = w })
      bot.on('windowUpdate', w => { filled = w.slots.filter(Boolean).length })
      bot.on('windowClose', () => { closed = true })

      bot._client.emit('container_open', { window_id: 2, window_type: 'container', coordinates: { x: 1, y: 2, z: 3 }, runtime_entity_id: -1n })
      assert.ok(opened, 'windowOpen should fire')
      assert.strictEqual(bot.currentWindow.id, 2)
      assert.deepStrictEqual(bot.currentWindow.position, { x: 1, y: 2, z: 3 })

      bot._client.emit('inventory_content', { window_id: 2, input: [{ network_id: 1, count: 5 }, { network_id: 0 }] })
      assert.strictEqual(filled, 1, 'one non-empty slot')

      bot._client.emit('container_set_data', { window_id: 2, property: 0, value: 100 })
      assert.strictEqual(bot.currentWindow.properties[0], 100)

      bot._client.emit('container_close', { window_id: 2, window_type: 'none', server: true })
      assert.strictEqual(bot.currentWindow, null)
      assert.strictEqual(closed, true)
    })

    it('a barrel opened again straight after closing waits until the world shows it shut', async function () {
      // A click names the block's state, and the server ignores one that names a state the block is no longer in. A barrel
      // closed a moment ago still shows open_bit 1 here until the server's update arrives. Seen on a Bedrock Dedicated
      // Server 1.26.60: a barrel clicked again within about 100 ms of closing never opened.
      const { bot } = makeBotFor(version)
      let barrel = { name: 'barrel', position: { x: 4, y: 5, z: 6 }, getProperties: () => ({ facing_direction: 1, open_bit: 1 }) }
      bot.blockAt = () => barrel
      const clicks = []
      bot.activateBlock = async (block) => { clicks.push(bot.blockAt(block.position).getProperties().open_bit) }

      bot._client.emit('container_open', { window_id: 2, window_type: 'container', coordinates: { x: 4, y: 5, z: 6 }, runtime_entity_id: -1n })
      bot._client.emit('inventory_content', { window_id: 2, input: [{ network_id: 0 }] })
      bot.closeWindow()
      const opened = bot.openContainer(barrel)
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.deepStrictEqual(clicks, [], 'no click while the barrel still shows open')

      barrel = { ...barrel, getProperties: () => ({ facing_direction: 1, open_bit: 0 }) }
      bot.emit('blockUpdate:(4, 5, 6)', null, barrel)
      await opened
      assert.deepStrictEqual(clicks, [0], 'clicked once, naming the shut barrel')
    })

    it('a container not closed just now, or one that shows shut, is clicked at once', async function () {
      const { bot } = makeBotFor(version)
      const barrel = { name: 'barrel', position: { x: 4, y: 5, z: 6 }, getProperties: () => ({ open_bit: 1 }) }
      const chest = { name: 'chest', position: { x: 7, y: 5, z: 6 }, getProperties: () => ({ facing_direction: 2 }) }
      bot.blockAt = (p) => (p.x === 4 ? barrel : chest)
      let clicks = 0
      bot.activateBlock = async () => { clicks++ }

      bot.openContainer(barrel) // open, but this bot did not just close it: another player holds it open
      assert.strictEqual(clicks, 1)

      bot._client.emit('container_open', { window_id: 3, window_type: 'container', coordinates: { x: 7, y: 5, z: 6 }, runtime_entity_id: -1n })
      bot._client.emit('inventory_content', { window_id: 3, input: [{ network_id: 0 }] })
      bot.closeWindow()
      bot.openContainer(chest) // a chest has one state, open or shut
      assert.strictEqual(clicks, 2)
    })

    it('bot.closeWindow sends container_close and clears the window', function () {
      const { bot, sent } = makeBot()
      bot._client.emit('container_open', { window_id: 3, window_type: 'container', coordinates: { x: 0, y: 0, z: 0 }, runtime_entity_id: -1n })
      let closed = false
      bot.on('windowClose', () => { closed = true })
      bot.closeWindow()
      const pkt = sent.find(p => p.name === 'container_close')
      assert.ok(pkt, 'container_close should be sent')
      assert.strictEqual(pkt.params.window_id, 3)
      assert.strictEqual(bot.currentWindow, null)
      assert.strictEqual(closed, true)
    })
  })
}
