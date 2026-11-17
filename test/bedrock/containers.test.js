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

    // A chest open next to the player's inventory, with the given stacks of cobblestone on each side. The server
    // answers every move 'ok' and hands out new stack ids from 100 up for slots a move fills.
    function chestWithCobblestone ({ chest = {}, inventory = {} }) {
      const registry = require('prismarine-registry')('bedrock_' + version)
      const type = registry.itemsByName.cobblestone.id
      const stack = (slot, count, stackId) => ({ name: 'cobblestone', type, count, slot, stackId })
      const bot = new EventEmitter()
      bot.registry = registry
      bot.blockAt = () => ({ name: 'chest' })
      const slots = new Array(46).fill(null)
      for (const [slot, [count, stackId]] of Object.entries(inventory)) slots[slot] = stack(Number(slot), count, stackId)
      bot.inventory = { slots, items: () => slots.filter(Boolean), updateSlot: (i, item) => { slots[i] = item } }
      const window = { id: 2, inventoryStart: 27, position: { x: 4, y: 5, z: 6 }, slots: new Array(27).fill(null) }
      for (const [slot, [count, stackId]] of Object.entries(chest)) window.slots[slot] = stack(Number(slot), count, stackId)
      const moves = []
      let nextId = 100
      bot._client = new EventEmitter()
      bot._client.queue = (name, params) => {
        if (name !== 'item_stack_request') return
        const request = params.requests[0]
        for (const action of request.actions) moves.push(action)
        const to = request.actions[0].destination
        const containers = [{ slot_type: to.slot_type, slots: [{ slot: to.slot, item_stack_id: to.stack_id || nextId++ }] }]
        setImmediate(() => bot._client.emit('item_stack_response', { responses: [{ request_id: request.request_id, status: 'ok', containers }] }))
      }
      injectContainers(bot)
      bot.currentWindow = window
      return { bot, window, slots, moves }
    }
    const brief = (move) => `${move.count} ${move.source.slot_type.container_id}[${move.source.slot}]#${move.source.stack_id} -> ${move.destination.slot_type.container_id}[${move.destination.slot}]#${move.destination.stack_id}`

    it('withdraw gathers the amount across stacks, topping up a stack in the inventory first', async function () {
      // Java's withdraw moves the amount asked for from as many stacks as it takes, onto stacks of the same item that
      // have room before empty slots. Here one move of 50 from a stack of 40 was refused by the server.
      const { bot, window, slots, moves } = chestWithCobblestone({ chest: { 0: [40, 36], 1: [20, 37] }, inventory: { 9: [60, 40] } })
      await bot.withdraw('cobblestone', null, 50)
      assert.deepStrictEqual(moves.map(brief), [
        '4 container[0]#36 -> inventory[9]#40',
        '36 container[0]#36 -> inventory[10]#0',
        '10 container[1]#37 -> inventory[10]#100'
      ])
      assert.strictEqual(slots[9].count, 64)
      assert.strictEqual(slots[10].count, 46)
      assert.strictEqual(window.slots[0], null)
      assert.strictEqual(window.slots[1].count, 10)
    })

    it('deposit gathers the amount across stacks, topping up a stack in the container first', async function () {
      const { bot, window, slots, moves } = chestWithCobblestone({ chest: { 0: [60, 36] }, inventory: { 9: [10, 40], 10: [10, 41] } })
      await bot.deposit('cobblestone', null, 15)
      assert.deepStrictEqual(moves.map(brief), [
        '4 inventory[9]#40 -> container[0]#36',
        '6 inventory[9]#40 -> container[1]#0',
        '5 inventory[10]#41 -> container[1]#100'
      ])
      assert.strictEqual(slots[9], null)
      assert.strictEqual(slots[10].count, 5)
      assert.strictEqual(window.slots[0].count, 64)
      assert.strictEqual(window.slots[1].count, 11)
    })

    it('asking for more than there is moves nothing and says how many there are', async function () {
      const taking = chestWithCobblestone({ chest: { 0: [40, 36] } })
      await assert.rejects(taking.bot.withdraw('cobblestone', null, 50), /40/)
      assert.deepStrictEqual(taking.moves, [])
      const putting = chestWithCobblestone({ inventory: { 9: [10, 40] } })
      await assert.rejects(putting.bot.deposit('cobblestone', null, 11), /10/)
      assert.deepStrictEqual(putting.moves, [])
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
