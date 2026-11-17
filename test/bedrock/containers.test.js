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

    it('a barrel\'s and a shulker box\'s slots go by their own name in a deposit and a withdraw', async function () {
      // A real server refuses (status 49 or 50) a move that calls a barrel's slots 'container'. Seen on a Bedrock Dedicated
      // Server 1.26.63.
      const registry = require('prismarine-registry')('bedrock_' + version)
      const cobblestone = registry.itemsByName.cobblestone.id
      for (const [block, expected] of [['chest', 'container'], ['barrel', 'barrel'], ['red_shulker_box', 'shulker'], ['undyed_shulker_box', 'shulker']]) {
        const bot = new EventEmitter()
        bot.registry = registry
        bot.blockAt = (pos) => (pos.x === 4 && pos.y === 5 && pos.z === 6 ? { name: block } : { name: 'air' })
        const slots = new Array(46).fill(null)
        slots[9] = { name: 'cobblestone', type: cobblestone, count: 3, slot: 9, stackId: 40 }
        bot.inventory = { slots, items: () => slots.filter(Boolean), updateSlot: (i, item) => { slots[i] = item } }
        const requests = []
        bot._client = new EventEmitter()
        bot._client.queue = (name, params) => {
          if (name !== 'item_stack_request') return
          const request = params.requests[0]
          requests.push(request)
          setImmediate(() => bot._client.emit('item_stack_response', { responses: [{ request_id: request.request_id, status: 'ok', containers: [] }] }))
        }
        injectContainers(bot)
        bot.currentWindow = { id: 2, inventoryStart: 27, position: { x: 4, y: 5, z: 6 }, slots: [{ name: 'cobblestone', type: cobblestone, count: 5, stackId: 36 }] }

        await bot.deposit('cobblestone', null, 3)
        await bot.withdraw('cobblestone', null, 5)

        assert.strictEqual(requests[0].actions[0].destination.slot_type.container_id, expected, `deposit into a ${block}`)
        assert.strictEqual(requests[1].actions[0].source.slot_type.container_id, expected, `withdraw from a ${block}`)
      }
    })

    it('an item withdrawn from a container keeps the stack id the server gave it', async function () {
      // Mock server: answers a take with what a real one sends, the emptied container slot and the filled inventory slot
      // with its stack id. Seen live on a Bedrock Dedicated Server 1.26.63.
      const registry = require('prismarine-registry')('bedrock_' + version)
      const cobblestone = registry.itemsByName.cobblestone.id
      const bot = new EventEmitter()
      bot.registry = registry
      const slots = new Array(46).fill(null)
      bot.inventory = { slots, items: () => slots.filter(Boolean), updateSlot: (i, item) => { slots[i] = item } }
      const requests = []
      bot._client = new EventEmitter()
      bot._client.queue = (name, params) => {
        if (name !== 'item_stack_request') return
        const request = params.requests[0]
        requests.push(request)
        setImmediate(() => bot._client.emit('item_stack_response', {
          responses: [{
            request_id: request.request_id,
            status: 'ok',
            containers: [
              { slot_type: { container_id: 'container' }, slots: [{ slot: 0, count: 0 }] },
              { slot_type: { container_id: 'inventory' }, slots: [{ slot: 9, count: 5, item_stack_id: 36 }] }
            ]
          }]
        }))
      }
      injectContainers(bot)
      bot.currentWindow = { id: 2, inventoryStart: 27, slots: [{ name: 'cobblestone', type: cobblestone, count: 5, stackId: 36 }] }

      await bot.withdraw('cobblestone', null, 5)

      assert.strictEqual(requests[0].actions[0].destination.slot, 9, 'taken into the first free inventory slot')
      assert.strictEqual(slots[9].count, 5)
      assert.strictEqual(slots[9].stackId, 36, 'without the id the server refuses the next request that moves this stack')
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
