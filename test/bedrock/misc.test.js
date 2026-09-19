/* eslint-env mocha */
// Offline behaviour tests for the smaller Bedrock plugins: spawn point and sounds. Each maps an inbound
// packet onto bot state or an event. Mock packets, no server.
const assert = require('assert')
const { EventEmitter } = require('events')
const registryLoader = require('prismarine-registry')
const { bedrockTestedVersions } = require('../../lib/version')
const injectSpawnPoint = require('../../lib/bedrock_plugins/spawn_point')
const injectSound = require('../../lib/bedrock_plugins/sound')

function baseBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  bot.entities = {}
  bot._client = new EventEmitter()
  return bot
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} misc plugins`, function () {
    it('spawn_point: set_spawn_position updates bot.spawnPoint', function () {
      const bot = baseBot(version)
      injectSpawnPoint(bot)
      bot._client.emit('set_spawn_position', { player_position: { x: 5, y: 64, z: -7 }, world_position: { x: 0, y: 0, z: 0 } })
      assert.strictEqual(bot.spawnPoint.x, 5)
      assert.strictEqual(bot.spawnPoint.y, 64)
      assert.strictEqual(bot.spawnPoint.z, -7)
    })

    it('sound: play_sound fires soundEffectHeard', function () {
      const bot = baseBot(version)
      injectSound(bot)
      let heard = null
      bot.on('soundEffectHeard', (name, pos, volume, pitch) => { heard = { name, volume, pitch } })
      bot._client.emit('play_sound', { name: 'random.pop', coordinates: { x: 8, y: 512, z: 8 }, volume: 1, pitch: 1 })
      assert.ok(heard)
      assert.strictEqual(heard.name, 'random.pop')
    })
  })
}
