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
  })
}
