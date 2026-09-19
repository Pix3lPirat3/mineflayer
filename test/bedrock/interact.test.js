/* eslint-env mocha */
// Offline guard for the Bedrock interaction plugin: every packet bot.swingArm / activateItem / deactivateItem /
// attack / useOn produces must serialize against the real protocol, and must address entities by their runtime id
// (a BigInt) rather than the persistent unique id. Passing the unique id (a large negative Number) used to crash the
// native varint writer with no catchable error, so serializing each emitted packet here is the regression that
// catches that whole class of bug without needing a live server.
const assert = require('assert')
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const injectInteract = require('../../lib/bedrock_plugins/interact')
const { bedrockTestedVersions } = require('../../lib/version')

function makeBot () {
  const sent = []
  const bot = {
    quickBarSlot: 0,
    heldItem: null,
    entities: { 5: { id: 5, uniqueId: -123456789n, position: { x: 1, y: 64, z: 2 } } },
    entity: { id: 321, uniqueId: -21474836399, position: { x: 0, y: 64, z: 0 }, eyeHeight: 1.62 },
    _client: { entityId: 321n, queue (name, params) { sent.push({ name, params }) } }
  }
  injectInteract(bot)
  return { bot, sent }
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} interactions serialize`, function () {
    const serializer = createSerializer(version)
    const check = (pkt) => assert.doesNotThrow(() => serializer.createPacketBuffer(pkt), `${pkt.name} should serialize`)

    it('swingArm emits a serializable animate using the runtime id', function () {
      const { bot, sent } = makeBot()
      bot.swingArm()
      assert.strictEqual(sent.length, 1)
      assert.strictEqual(sent[0].name, 'animate')
      assert.strictEqual(sent[0].params.runtime_entity_id, 321n, 'must use _client.entityId, not entity.uniqueId')
      check(sent[0])
    })

    it('activateItem emits a serializable item_use plus a swing', function () {
      const { bot, sent } = makeBot()
      bot.activateItem()
      const names = sent.map(p => p.name)
      assert.deepStrictEqual(names, ['inventory_transaction', 'animate'])
      assert.strictEqual(sent[0].params.transaction.transaction_type, 'item_use')
      sent.forEach(check)
    })

    it('deactivateItem emits a serializable player_action', function () {
      const { bot, sent } = makeBot()
      bot.deactivateItem()
      assert.strictEqual(sent[0].name, 'player_action')
      assert.strictEqual(sent[0].params.runtime_entity_id, 321n)
      check(sent[0])
    })

    it('attack targets the entity runtime id and serializes', function () {
      const { bot, sent } = makeBot()
      bot.attack(bot.entities[5])
      assert.strictEqual(sent[0].name, 'inventory_transaction')
      const data = sent[0].params.transaction.transaction_data
      assert.strictEqual(sent[0].params.transaction.transaction_type, 'item_use_on_entity')
      assert.strictEqual(data.entity_runtime_id, 5n, 'must use entity.id (runtime), not uniqueId')
      assert.strictEqual(data.action_type, 'attack')
      sent.forEach(check)
    })

    it('useOn sends an interact transaction and serializes', function () {
      const { bot, sent } = makeBot()
      bot.useOn(bot.entities[5])
      assert.strictEqual(sent[0].params.transaction.transaction_data.action_type, 'interact')
      sent.forEach(check)
    })

    it('attack throws on an unknown entity rather than sending', function () {
      const { bot, sent } = makeBot()
      assert.throws(() => bot.attack(999))
      assert.strictEqual(sent.length, 0)
    })
  })
}
