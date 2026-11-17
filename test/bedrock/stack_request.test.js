/* eslint-env mocha */
// Offline test for the action type byte an item_stack_request action carries next to its variant. The server reads
// the action's body by that byte, so a wrong one makes it drop the whole request without an answer. 1.26.60 added
// craft_reserved before the last two actions and moved their bytes up by one; the expected values are the
// ItemStackRequestActionType enum of gophertunnel v1.62.0 (1.26.5x) and v1.63.0 (1.26.60).
const assert = require('assert')
const { EventEmitter } = require('events')
const registryLoader = require('prismarine-registry')
const injectStackRequest = require('../../lib/bedrock_plugins/stack_request')

function makeBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  bot._client = new EventEmitter()
  bot._client.queue = () => {}
  bot.inventory = { slots: [] }
  injectStackRequest(bot)
  return bot
}

const SAME_ON_BOTH = {
  take: 0,
  place: 1,
  swap: 2,
  drop: 3,
  destroy: 4,
  consume: 5,
  create: 6,
  beacon_payment: 10,
  craft_recipe: 12,
  craft_creative: 14,
  optional: 15,
  craft_grindstone_request: 16,
  craft_loom_request: 17
}

describe('bedrock item_stack_request action type bytes', function () {
  it('1.26.51: results_deprecated is 19', function () {
    const bot = makeBot('1.26.51')
    for (const [name, byte] of Object.entries(SAME_ON_BOTH)) assert.strictEqual(bot._stack.legacyTypeId(name), byte, name)
    assert.strictEqual(bot._stack.legacyTypeId('non_implemented'), 18)
    assert.strictEqual(bot._stack.legacyTypeId('results_deprecated'), 19)
  })

  it('1.26.60: craft_reserved is 18, so results_deprecated moves to 20', function () {
    const bot = makeBot('1.26.60')
    for (const [name, byte] of Object.entries(SAME_ON_BOTH)) assert.strictEqual(bot._stack.legacyTypeId(name), byte, name)
    assert.strictEqual(bot._stack.legacyTypeId('craft_reserved'), 18)
    assert.strictEqual(bot._stack.legacyTypeId('non_implemented'), 19)
    assert.strictEqual(bot._stack.legacyTypeId('results_deprecated'), 20)
  })

  it('an action the version does not have is an error, not a guess', function () {
    const bot = makeBot('1.26.51')
    assert.throws(() => bot._stack.legacyTypeId('craft_reserved'), /craft_reserved/)
  })
})
