/* eslint-env mocha */
// Offline tests for the station calls' item moves. No server: the item_stack_request plumbing is stood in for and
// records each request, and the server's answer is always ok.
const assert = require('assert')
const { EventEmitter } = require('events')
const registryLoader = require('prismarine-registry')
const injectStations = require('../../lib/bedrock_plugins/stations')

function makeBot (holding) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_1.26.60')
  bot._client = new EventEmitter()
  const slots = []
  holding.forEach(([name, count], i) => {
    slots[36 + i] = { name, type: bot.registry.itemsByName[name].id, count, slot: 36 + i, metadata: 0, stackId: 100 + i }
  })
  bot.inventory = {
    slots,
    items: () => slots.filter(Boolean),
    updateSlot: (slot, item) => { slots[slot] = item || undefined }
  }
  const requests = []
  let id = -1
  bot._stack = {
    stackReq: async (actions) => {
      const rid = id
      id -= 2
      requests.push(typeof actions === 'function' ? actions(rid) : actions)
      return { status: 'ok', id: rid, response: {} }
    },
    stackIdFor: () => 7,
    applyStackIds: () => {},
    bedrockOf: (slot) => slot - 36,
    invContainer: () => 'hotbar_and_inventory',
    firstFreeBedrockSlot: () => 20,
    legacyTypeId: (name) => ({ results_deprecated: 20 })[name]
  }
  injectStations(bot)
  return { bot, requests }
}

describe('bedrock loom', function () {
  it('puts one dye in the loom, the one the pattern uses, and leaves the rest in the inventory', async function () {
    const { bot, requests } = makeBot([['banner', 1], ['red_dye', 5]])
    await bot.loom(null, 'banner', 'red_dye', 'bo')
    const dyePlace = requests.map(r => r[0]).find(a => a.type_id === 'place' && a.destination.slot_type.container_id === 'loom_dye')
    assert.strictEqual(dyePlace.count, 1, 'the whole stack went into the loom, and only one dye is used up')
    const craft = requests.find(r => r[0].type_id === 'craft_loom_request')
    const dyeConsume = craft.find(a => a.type_id === 'consume' && a.source.slot_type.container_id === 'loom_dye')
    assert.strictEqual(dyeConsume.count, dyePlace.count, 'what is put in is all used up, so nothing is left in the loom')
    const dye = bot.inventory.items().find(i => i.name === 'red_dye')
    assert.strictEqual(dye && dye.count, 4)
  })

  it('a single dye is put in and used up, and none is left', async function () {
    const { bot, requests } = makeBot([['banner', 1], ['red_dye', 1]])
    await bot.loom(null, 'banner', 'red_dye', 'bo')
    const dyePlace = requests.map(r => r[0]).find(a => a.type_id === 'place' && a.destination.slot_type.container_id === 'loom_dye')
    assert.strictEqual(dyePlace.count, 1)
    assert.strictEqual(bot.inventory.items().find(i => i.name === 'red_dye'), undefined)
  })
})
