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

    it('equip to hand selects a hotbar item', async function () {
      const { bot } = makeBot(version)
      bot.entity = { id: 77, setEquipment () {}, position: { x: 0, y: 64, z: 0 } }
      bot.inventory.updateSlot(38, { name: 'iron_sword', type: 308, count: 1, stackId: 2 }) // hotbar slot 2
      await bot.equip('iron_sword', 'hand')
      assert.strictEqual(bot.quickBarSlot, 2, 'selected the sword hotbar slot')
    })

    it('equip to armor sends a place into the armor container and wears it on the ok response', async function () {
      const { bot, sent } = makeBot(version)
      bot.entity = { id: 77, setEquipment () {}, position: { x: 0, y: 64, z: 0 } }
      bot.currentWindow = { id: 0 } // pretend the inventory screen is open
      bot.inventory.updateSlot(36, { name: 'iron_helmet', type: 298, count: 1, stackId: 4 }) // hotbar slot 0
      // auto-ok the item_stack_request
      bot._client.queue = (name, params) => { sent.push({ name, params }); if (name === 'item_stack_request') { const r = params.requests[0]; setImmediate(() => bot._client.emit('item_stack_response', { responses: [{ request_id: r.request_id, status: 'ok', containers: [{ slot_type: { container_id: 'armor' }, slots: [{ slot: 0, count: 1 }] }] }] })) } }
      await bot.equip('iron_helmet', 'head')
      await new Promise(resolve => setTimeout(resolve, 50))
      const req = sent.find(p => p.name === 'item_stack_request')
      assert.strictEqual(req.params.requests[0].actions[0].destination.slot_type.container_id, 'armor')
      assert.strictEqual(req.params.requests[0].actions[0].destination.slot, 0, 'head is armor slot 0')
      assert.ok(bot.inventory.slots[5] && bot.inventory.slots[5].name === 'iron_helmet', 'helmet worn in the head slot (5)')
      assert.ok(!bot.inventory.slots[36], 'source hotbar slot cleared')
    })

    it('toss drops from the item slot and shrinks the stack on the ok response', async function () {
      const { bot, sent } = makeBot(version)
      bot.entity = { id: 77, setEquipment () {}, position: { x: 0, y: 64, z: 0 } }
      bot.inventory.updateSlot(36, { name: 'dirt', type: 3, count: 20, stackId: 9 }) // hotbar slot 0
      const serializer = createSerializer(version)
      bot._client.queue = (name, params) => { sent.push({ name, params }); if (name === 'item_stack_request') { const r = params.requests[0]; setImmediate(() => bot._client.emit('item_stack_response', { responses: [{ request_id: r.request_id, status: 'ok', containers: [] }] })) } }
      await bot.toss('dirt', null, 5)
      await new Promise(resolve => setTimeout(resolve, 30))
      const req = sent.find(p => p.name === 'item_stack_request')
      assert.strictEqual(req.params.requests[0].actions[0].type_id, 'drop')
      assert.strictEqual(req.params.requests[0].actions[0].count, 5)
      assert.doesNotThrow(() => serializer.createPacketBuffer(req), 'drop item_stack_request must serialize')
      assert.strictEqual(bot.inventory.slots[36].count, 15, 'stack shrank by the dropped count')
    })

    it('equip off-hand is reported as not yet supported', async function () {
      const { bot } = makeBot(version)
      bot.entity = { id: 77, setEquipment () {}, position: { x: 0, y: 64, z: 0 } }
      bot.inventory.updateSlot(36, { name: 'shield', type: 355, count: 1, stackId: 1 })
      await assert.rejects(() => bot.equip('shield', 'off-hand'), /not yet supported/)
    })

    it('depositItem emits a serializable place into the container container_id', function () {
      const { bot, sent } = makeBot(version)
      bot.currentWindow = { id: 5, type: 'container', slots: [] }
      bot.inventory.updateSlot(36, { name: 'dirt', type: 3, count: 10, stackId: 7 })
      bot.depositItem(0, 0, 10) // hotbar slot 0 -> container slot 0
      const req = sent.find(p => p.name === 'item_stack_request')
      assert.ok(req, 'item_stack_request should be sent')
      const action = req.params.requests[0].actions[0]
      assert.strictEqual(action.type_id, 'place')
      assert.strictEqual(action.source.slot_type.container_id, 'hotbar')
      assert.strictEqual(action.destination.slot_type.container_id, 'container')
      assert.strictEqual(action.source.stack_id, 7)
      assert.doesNotThrow(() => serializer.createPacketBuffer(req), 'item_stack_request must serialize')
    })

    it('withdrawItem takes from the container into a player slot and serializes', function () {
      const { bot, sent } = makeBot(version)
      bot.currentWindow = { id: 5, type: 'container', slots: [{ name: 'dirt', type: 3, count: 4, stackId: 27 }] }
      bot.withdrawItem(0, 9, 4) // container slot 0 -> inventory slot 9 (main slot 0)
      const req = sent.find(p => p.name === 'item_stack_request')
      const action = req.params.requests[0].actions[0]
      assert.strictEqual(action.source.slot_type.container_id, 'container')
      assert.strictEqual(action.source.stack_id, 27)
      assert.strictEqual(action.destination.slot_type.container_id, 'inventory')
      assert.doesNotThrow(() => serializer.createPacketBuffer(req), 'item_stack_request must serialize')
    })

    it('depositItem/withdrawItem throw when no container is open', function () {
      const { bot } = makeBot(version)
      bot.currentWindow = null
      assert.throws(() => bot.depositItem(0, 0))
      assert.throws(() => bot.withdrawItem(0, 9))
    })
  })
}
