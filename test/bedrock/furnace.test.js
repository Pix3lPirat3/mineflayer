/* eslint-env mocha */
// Offline test for the Bedrock furnace plugin: bot.smelt opens the furnace, places fuel into furnace_fuel slot 1 and
// the smeltable into furnace_ingredient slot 0, waits for furnace_output slot 2 to fill, takes it, and stores the
// result. The slot layout and container ids are the ones verified live. Mock item_stack_response, no server.
const assert = require('assert')
const { EventEmitter } = require('events')
const registryLoader = require('prismarine-registry')
const injectFurnace = require('../../lib/bedrock_plugins/furnace')
const { bedrockTestedVersions } = require('../../lib/version')

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} furnace plugin`, function () {
    it('smelt loads fuel + input into the right slots and takes the output', async function () {
      const reg = registryLoader('bedrock_' + version)
      const coalId = reg.itemsByName.coal?.id ?? 388
      const cobbleId = reg.itemsByName.cobblestone?.id ?? 4
      const stoneId = reg.itemsByName.stone?.id ?? 1
      const sent = []
      const bot = new EventEmitter()
      bot.registry = reg
      const slots = new Array(46).fill(null)
      slots[36] = { name: 'coal', type: coalId, count: 4, stackId: 7 } // hotbar 0
      slots[37] = { name: 'cobblestone', type: cobbleId, count: 3, stackId: 8 } // hotbar 1
      bot.inventory = { slots, items: () => slots.map((it, i) => it && Object.assign({}, it, { slot: i })).filter(Boolean), updateSlot: (i, item) => { slots[i] = item } }
      bot.currentWindow = null
      bot.openContainer = () => { bot.currentWindow = { id: 4, type: 'furnace', slots: [] }; setImmediate(() => bot.emit('windowOpen', bot.currentWindow)) }
      bot._client = new EventEmitter()
      bot._client.queue = (name, params) => {
        sent.push({ name, params })
        if (name !== 'item_stack_request') return
        const req = params.requests[0]
        const act = req.actions[0]
        setImmediate(() => {
          // when the smeltable is placed, simulate the furnace producing the output
          if (act.type_id === 'place' && act.destination.slot_type.container_id === 'furnace_ingredient') {
            bot.currentWindow.slots[2] = { name: 'stone', type: stoneId, count: 1, stackId: 55 }
          }
          bot._client.emit('item_stack_response', { responses: [{ request_id: req.request_id, status: 'ok', containers: [] }] })
        })
      }
      injectFurnace(bot)

      const result = await bot.smelt({ name: 'furnace', position: { x: 0, y: 64, z: 0 } }, 'cobblestone', 'coal', 1)
      const places = sent.filter(s => s.name === 'item_stack_request').map(s => s.params.requests[0].actions[0])
      const fuel = places.find(a => a.destination && a.destination.slot_type.container_id === 'furnace_fuel')
      const input = places.find(a => a.destination && a.destination.slot_type.container_id === 'furnace_ingredient')
      const take = places.find(a => a.type_id === 'take' && a.source.slot_type.container_id === 'furnace_output')
      assert.ok(fuel && fuel.destination.slot === 1, 'fuel goes to furnace_fuel slot 1')
      assert.ok(input && input.destination.slot === 0, 'smeltable goes to furnace_ingredient slot 0')
      assert.ok(take && take.source.slot === 2, 'output is taken from furnace_output slot 2')
      assert.strictEqual(result.type, stoneId, 'smelt resolves with the output item')
      assert.ok(slots.some(it => it && it.type === stoneId), 'the smelted output is stored')
    })

    it('putFuel / putSmeltable throw when the needed item is absent', async function () {
      const bot = new EventEmitter()
      bot.registry = registryLoader('bedrock_' + version)
      bot.inventory = { slots: new Array(46).fill(null), items: () => [], updateSlot: () => {} }
      bot.currentWindow = { id: 4, type: 'furnace', slots: [] }
      bot._client = new EventEmitter()
      bot._client.queue = () => {}
      injectFurnace(bot)
      await assert.rejects(() => bot.putFuel('coal'), /no coal/)
      await assert.rejects(() => bot.putSmeltable('cobblestone'), /no cobblestone/)
    })
  })
}
