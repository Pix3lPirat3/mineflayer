/* eslint-env mocha */
// Offline test for the Bedrock crafting recipe book: a crafting_data packet is parsed into a queryable index, shaped
// and shapeless recipes are both indexed by their result, requiresTable is derived from the grid size, and recipesFor
// filters by result item and (2x2 vs table) size. Mock packet, no server.
const assert = require('assert')
const { EventEmitter } = require('events')
const injectCrafting = require('../../lib/bedrock_plugins/crafting')
const { bedrockTestedVersions } = require('../../lib/version')

// Minimal fake registry: two items by name/id.
const registry = {
  itemsByName: { oak_planks: { id: 5 }, crafting_table: { id: 58 }, oak_log: { id: 17 }, stick: { id: 280 } }
}
// Map output network ids back to a canonical item for the test.
const netToItem = { 105: { type: 5, name: 'oak_planks', count: 4 }, 158: { type: 58, name: 'crafting_table', count: 1 } }

function makeBot () {
  const bot = new EventEmitter()
  bot.registry = registry
  bot._bedrockItemFromNotch = (it) => (it && it.network_id ? netToItem[it.network_id] : null)
  bot._client = new EventEmitter()
  injectCrafting(bot)
  return bot
}

const craftingData = {
  shapeless_recipes: [
    { recipe_id: 'minecraft:oak_planks', network_id: 1300, input: [{ type: 'valid', descriptor_type: 'item_tag', tag: 'minecraft:oak_logs', count: 1 }], output: [{ network_id: 105, count: 4 }] }
  ],
  shaped_recipes: [
    { recipe_id: 'minecraft:crafting_table', network_id: 42, width: 2, height: 2, input: [{ type: 'valid', descriptor_type: 'name', name: 'minecraft:oak_planks', count: 1 }, { type: 'valid', descriptor_type: 'name', name: 'minecraft:oak_planks', count: 1 }, { type: 'valid', descriptor_type: 'name', name: 'minecraft:oak_planks', count: 1 }, { type: 'valid', descriptor_type: 'name', name: 'minecraft:oak_planks', count: 1 }], output: [{ network_id: 158, count: 1 }] },
    { recipe_id: 'minecraft:big', network_id: 99, width: 3, height: 3, input: new Array(9).fill({ type: 'valid', descriptor_type: 'name', name: 'minecraft:oak_planks', count: 1 }), output: [{ network_id: 105, count: 1 }] }
  ]
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} crafting plugin`, function () {
    it('parses crafting_data into a recipe index keyed by result', function () {
      const bot = makeBot()
      let ready = 0
      bot.on('craftingRecipesReady', n => { ready = n })
      bot._client.emit('crafting_data', craftingData)
      assert.strictEqual(ready, 3, 'three recipes parsed')
      assert.strictEqual(bot.craftingRecipes.length, 3)
    })

    it('recipesFor returns the shapeless planks recipe with its network id and ingredient', function () {
      const bot = makeBot()
      bot._client.emit('crafting_data', craftingData)
      const recipes = bot.recipesFor('oak_planks')
      const shapeless = recipes.find(r => r.type === 'shapeless')
      assert.ok(shapeless, 'shapeless planks recipe found')
      assert.strictEqual(shapeless.id, 1300, 'carries the recipe network id')
      assert.strictEqual(shapeless.result.count, 4)
      assert.deepStrictEqual(shapeless.ingredients[0], { tag: 'minecraft:oak_logs', count: 1 })
    })

    it('derives requiresTable from grid size and filters on it', function () {
      const bot = makeBot()
      bot._client.emit('crafting_data', craftingData)
      const table2x2 = bot.recipesFor('crafting_table').find(r => r.id === 42)
      assert.strictEqual(table2x2.requiresTable, false, '2x2 fits the inventory grid')
      // the 3x3 planks recipe requires a table, so it is excluded without one
      const withoutTable = bot.recipesFor('oak_planks', null, 1, false).map(r => r.id)
      assert.ok(!withoutTable.includes(99), '3x3 recipe excluded without a table')
      const withTable = bot.recipesFor('oak_planks', null, 1, true).map(r => r.id)
      assert.ok(withTable.includes(99), '3x3 recipe included with a table')
    })

    it('craft places the ingredient, sends the verified craft actions, and stores the result', async function () {
      const registryLoader = require('prismarine-registry')
      const reg = registryLoader('bedrock_' + version)
      const planksId = reg.itemsByName.oak_planks.id
      const logId = reg.itemsByName.oak_log?.id ?? 17
      const sent = []
      const bot = new (require('events').EventEmitter)()
      bot.registry = reg
      const slots = new Array(46).fill(null)
      slots[36] = { name: 'oak_log', type: logId, count: 4, stackId: 5 } // hotbar slot 0
      bot.inventory = { slots, items: () => slots.map((it, i) => it && Object.assign({}, it, { slot: i })).filter(Boolean), updateSlot: (i, item) => { slots[i] = item } }
      bot.currentWindow = { id: 0 } // pretend the inventory screen is open so craft does not try to open it
      bot._client = new (require('events').EventEmitter)()
      bot._client.queue = (name, params) => {
        sent.push({ name, params })
        if (name !== 'item_stack_request') return
        const req = params.requests[0]
        const isCraft = req.actions.some(a => a.type_id === 'craft_recipe')
        setImmediate(() => bot._client.emit('item_stack_response', {
          responses: [{ request_id: req.request_id, status: 'ok', containers: isCraft ? [] : [{ slot_type: { container_id: 'crafting_input' }, slots: [{ slot: 28, count: 1, item_stack_id: 99 }] }] }]
        }))
      }
      injectCrafting(bot)
      const recipe = { id: 564, type: 'shaped', width: 1, height: 1, result: { type: planksId, id: planksId, count: 4, metadata: 0 }, ingredients: [{ name: 'oak_log', id: logId, count: 1 }], requiresTable: false }
      await bot.craft(recipe, 1)

      const craftReq = sent.map(s => s.params?.requests?.[0]).find(r => r && r.actions.some(a => a.type_id === 'craft_recipe'))
      assert.ok(craftReq, 'a craft_recipe request is sent')
      const cr = craftReq.actions.find(a => a.type_id === 'craft_recipe')
      assert.strictEqual(cr.recipe_network_id, 564)
      const consume = craftReq.actions.find(a => a.type_id === 'consume')
      assert.strictEqual(consume.source.slot_type.container_id, 'crafting_input')
      assert.strictEqual(consume.source.stack_id, 99, 'consume uses the grid stack id from the place response')
      const take = craftReq.actions.find(a => a.type_id === 'take')
      assert.strictEqual(take.source.slot_type.container_id, 'creative_output')
      assert.strictEqual(take.source.slot, 50)
      assert.strictEqual(take.source.stack_id, craftReq.request_id, 'the output stack id is the request id')
      // result stored in the first free slot (hotbar 1 -> player slot 37), log consumed
      assert.ok(slots[37] && slots[37].type === planksId && slots[37].count === 4, 'crafted planks stored')
      assert.strictEqual(slots[36].count, 3, 'one log consumed from the stack')
    })

    it('craft on a table places a shaped 3x3 recipe into the right grid cells (skipping gaps)', async function () {
      const { EventEmitter } = require('events')
      const registryLoader = require('prismarine-registry')
      const reg = registryLoader('bedrock_' + version)
      const chestId = reg.itemsByName.chest?.id ?? 54
      const planksId = reg.itemsByName.oak_planks.id
      const sent = []
      const bot = new EventEmitter()
      bot.registry = reg
      const slots = new Array(46).fill(null)
      slots[36] = { name: 'oak_planks', type: planksId, count: 64, stackId: 3 } // hotbar 0, plenty
      bot.inventory = { slots, items: () => slots.map((it, i) => it && Object.assign({}, it, { slot: i })).filter(Boolean), updateSlot: (i, item) => { slots[i] = item } }
      bot.currentWindow = null
      bot.openContainer = () => { bot.currentWindow = { id: 3, type: 'workbench' }; setImmediate(() => bot.emit('windowOpen', bot.currentWindow)) }
      bot._client = new EventEmitter()
      bot._client.queue = (name, params) => {
        sent.push({ name, params })
        if (name !== 'item_stack_request') return
        const req = params.requests[0]
        const isCraft = req.actions.some(a => a.type_id === 'craft_recipe')
        const placeSlot = (req.actions.find(a => a.type_id === 'place')?.destination?.slot)
        setImmediate(() => bot._client.emit('item_stack_response', { responses: [{ request_id: req.request_id, status: 'ok', containers: isCraft ? [] : [{ slot_type: { container_id: 'crafting_input' }, slots: [{ slot: placeSlot, count: 1, item_stack_id: 900 + placeSlot }] }] }] }))
      }
      injectCrafting(bot)
      const p = { name: 'oak_planks', id: planksId, count: 1 }
      const recipe = { id: 1054, type: 'shaped', width: 3, height: 3, result: { type: chestId, id: chestId, count: 1, metadata: 0 }, ingredients: new Array(8).fill(p), shape: [p, p, p, p, null, p, p, p, p], requiresTable: true }
      await bot.craft(recipe, 1, { name: 'crafting_table', position: { x: 0, y: 64, z: 0 } })

      const gridSlots = sent.filter(s => s.name === 'item_stack_request').map(s => s.params.requests[0].actions.find(a => a.type_id === 'place')).filter(Boolean).map(a => a.destination.slot).sort((a, b) => a - b)
      assert.deepStrictEqual(gridSlots, [32, 33, 34, 35, 37, 38, 39, 40], '3x3 ring maps to crafting_input 32-40 skipping the centre (36)')
      const craftReq = sent.map(s => s.params?.requests?.[0]).find(r => r && r.actions.some(a => a.type_id === 'craft_recipe'))
      assert.strictEqual(craftReq.actions.filter(a => a.type_id === 'consume').length, 8, 'consumes all eight grid items')
      assert.ok(slots.some(it => it && it.type === chestId), 'the crafted chest is stored')
    })

    it('craft throws for a table recipe without a table, and for a missing ingredient', async function () {
      const bot = makeBot()
      bot.inventory = { slots: new Array(46).fill(null), items: () => [], updateSlot: () => {} }
      bot.currentWindow = { id: 0 }
      bot._client.emit('crafting_data', craftingData)
      await assert.rejects(() => bot.craft({ id: 99, requiresTable: true, result: { type: 5, count: 1 }, ingredients: [] }), /crafting table/)
      await assert.rejects(() => bot.craft({ id: 1, requiresTable: false, result: { type: 5, count: 1 }, ingredients: [{ name: 'diamond' }] }), /missing ingredient/)
    })
  })
}
