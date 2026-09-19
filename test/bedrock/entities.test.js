/* eslint-env mocha */
// Offline behaviour test for the Bedrock entities plugin. It feeds mock inbound packets and asserts the plugin keys
// bot.entities by the RUNTIME id (entity.id) while storing the persistent unique id separately as entity.uniqueId.
// That distinction is exactly what the interaction packets depend on (a mixed-up id crashes the varint writer), so
// locking it here keeps the whole entity/interaction surface regression-proof without a live server.
const assert = require('assert')
const { EventEmitter } = require('events')
const registryLoader = require('prismarine-registry')
const injectEntities = require('../../lib/bedrock_plugins/entities')
const { bedrockTestedVersions } = require('../../lib/version')

function makeBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  bot.players = {}
  bot.entities = {}
  bot.entity = null
  bot._warn = () => {}
  bot._bedrockItemFromNotch = () => null
  bot._client = new EventEmitter()
  injectEntities(bot)
  return bot
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} entities plugin`, function () {
    it('keys a mob by runtime id and stores the unique id separately', function () {
      const bot = makeBot(version)
      const runtimeId = 42
      const uniqueId = -987654321n
      bot._client.emit('add_entity', {
        runtime_id: runtimeId,
        unique_id: uniqueId,
        entity_type: 'minecraft:zombie',
        position: { x: 10, y: 64, z: -5 },
        velocity: { x: 0, y: 0, z: 0 },
        yaw: 0,
        pitch: 0,
        head_yaw: 0,
        metadata: [],
        attributes: []
      })
      const e = bot.entities[runtimeId]
      assert.ok(e, 'entity should be keyed by its runtime id')
      assert.strictEqual(e.id, runtimeId, 'entity.id is the runtime id')
      assert.strictEqual(e.uniqueId, uniqueId, 'entity.uniqueId is the persistent id, kept distinct from the runtime id')
      assert.strictEqual(e.name, 'zombie')
      assert.ok(e.type, 'type resolved from the registry')
      assert.strictEqual(e.position.x, 10)
    })

    it('resolves an unknown entity type to a safe placeholder without throwing', function () {
      const bot = makeBot(version)
      bot._client.emit('add_entity', {
        runtime_id: 5,
        unique_id: 5n,
        entity_type: 'minecraft:some_future_mob',
        position: { x: 0, y: 64, z: 0 },
        metadata: [],
        attributes: []
      })
      const e = bot.entities[5]
      assert.ok(e)
      assert.strictEqual(e.type, 'other')
      assert.strictEqual(e.kind, 'unknown')
    })

    it('spawns a player entity typed as player with username and uuid', function () {
      const bot = makeBot(version)
      bot._client.emit('add_player', {
        runtime_id: 7,
        uuid: '11111111-2222-3333-4444-555555555555',
        username: 'Tester',
        unique_id: 7n,
        position: { x: 1, y: 64, z: 1 },
        yaw: 0,
        pitch: 0,
        head_yaw: 0,
        gamemode: 0,
        metadata: []
      })
      const e = bot.entities[7]
      assert.ok(e)
      assert.strictEqual(e.type, 'player')
      assert.strictEqual(e.username, 'Tester')
      assert.strictEqual(e.uuid, '11111111-2222-3333-4444-555555555555')
    })

    it('nearestEntity finds a spawned entity relative to the bot', function () {
      const bot = makeBot(version)
      const Entity = require('prismarine-entity')(bot.registry)
      bot.entity = new Entity(1)
      bot.entity.position.set(0, 64, 0)
      bot._client.emit('add_entity', { runtime_id: 99, unique_id: 99n, entity_type: 'minecraft:cow', position: { x: 3, y: 64, z: 0 }, metadata: [], attributes: [] })
      const near = bot.nearestEntity()
      assert.ok(near)
      assert.strictEqual(near.id, 99)
    })

    it('removes an entity on remove_entity', function () {
      const bot = makeBot(version)
      bot._client.emit('add_entity', { runtime_id: 8, unique_id: 8n, entity_type: 'minecraft:pig', position: { x: 0, y: 64, z: 0 }, metadata: [], attributes: [] })
      assert.ok(bot.entities[8])
      bot._client.emit('remove_entity', { entity_id_self: 8n })
      assert.ok(!bot.entities[8], 'entity should be gone after remove_entity')
    })
  })
}
