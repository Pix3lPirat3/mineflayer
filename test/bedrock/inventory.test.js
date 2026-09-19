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

    it('moveInventoryItem emits a serializable item_stack_request and applies an ok response', function () {
      const { bot, sent } = makeBot(version)
      const serializer = createSerializer(version)
      bot.inventory.updateSlot(36, { name: 'dirt', type: 3, count: 64, stackId: 4 }) // bedrock hotbar slot 0
      const rid = bot.moveInventoryItem(0, 2) // hotbar 0 -> hotbar 2 (empty) => place
      const req = sent.find(p => p.name === 'item_stack_request')
      assert.ok(req, 'item_stack_request should be sent')
      assert.strictEqual(req.params.requests[0].actions[0].type_id, 'place')
      assert.strictEqual(req.params.requests[0].actions[0].source.slot_type.container_id, 'hotbar')
      assert.doesNotThrow(() => serializer.createPacketBuffer(req), 'item_stack_request must serialize')
      // apply an ok response and confirm the item moved locally (slot 36 -> slot 38)
      bot._client.emit('item_stack_response', { responses: [{ status: 'ok', request_id: rid, containers: [{ slot_type: { container_id: 'hotbar' }, slots: [{ slot: 0, count: 0 }, { slot: 2, count: 64, item_stack_id: 20 }] }] }] })
      assert.ok(!bot.inventory.slots[36], 'source slot cleared')
      assert.ok(bot.inventory.slots[38] && bot.inventory.slots[38].name === 'dirt', 'item moved to hotbar slot 2')
    })

    it('rejects an out-of-range hotbar slot', function () {
      const { bot } = makeBot(version)
      assert.throws(() => bot.setQuickBarSlot(9))
      assert.throws(() => bot.setQuickBarSlot(-1))
    })
  })
}
