/* eslint-env mocha */
// Offline test for the Bedrock inventory plugin's outbound path: selecting a hotbar slot must emit a mob_equipment
// packet that serialises against the real protocol and addresses the player by runtime id (entity.id), not the unique
// id. Serialising the emitted packet guards the same varint-overflow class of bug the interaction test covers.
const assert = require('assert')
const { EventEmitter } = require('events')
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const registryLoader = require('prismarine-registry')
const injectInventory = require('../../lib/bedrock_plugins/inventory')
const { bedrockTestedVersions } = require('../../lib/version')

function makeBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  bot._warn = () => {}
  const sent = []
  bot._client = new EventEmitter()
  bot._client.queue = (name, params) => sent.push({ name, params })
  injectInventory(bot)
  bot.entity = { id: 77, setEquipment () {} }
  return { bot, sent }
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} inventory plugin`, function () {
    const serializer = createSerializer(version)

    it('setQuickBarSlot emits a serializable mob_equipment with the runtime id', function () {
      const { bot, sent } = makeBot(version)
      bot.setQuickBarSlot(3)
      assert.strictEqual(bot.quickBarSlot, 3)
      const eq = sent.find(p => p.name === 'mob_equipment')
      assert.ok(eq, 'mob_equipment should be sent')
      assert.strictEqual(eq.params.slot, 3)
      assert.strictEqual(Number(eq.params.runtime_entity_id), 77, 'addresses the player by runtime id')
      assert.doesNotThrow(() => serializer.createPacketBuffer(eq), 'mob_equipment must serialize')
    })

    it('sets up an inventory window and a heldItem accessor', function () {
      const { bot } = makeBot(version)
      assert.ok(bot.inventory, 'inventory window exists')
      assert.strictEqual(bot.QUICK_BAR_START, 36)
      assert.doesNotThrow(() => { const _ = bot.heldItem }) // eslint-disable-line no-unused-vars
    })

    it('rejects an out-of-range hotbar slot', function () {
      const { bot } = makeBot(version)
      assert.throws(() => bot.setQuickBarSlot(9))
      assert.throws(() => bot.setQuickBarSlot(-1))
    })
  })
}
