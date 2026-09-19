/* eslint-env mocha */
// Offline behaviour test for the Bedrock health plugin: it must map the player's health/food attributes onto
// bot.health/bot.food, fire health/death/spawn at the right transitions, ignore attribute updates for other
// entities, and drive the respawn handshake. Mock inbound packets, no server.
const assert = require('assert')
const { EventEmitter } = require('events')
const injectHealth = require('../../lib/bedrock_plugins/health')
const { bedrockTestedVersions } = require('../../lib/version')

function makeBot () {
  const bot = new EventEmitter()
  const sent = []
  bot._client = new EventEmitter()
  bot._client.queue = (name, params) => sent.push({ name, params })
  injectHealth(bot, { respawn: false })
  bot._client.emit('start_game', { runtime_entity_id: 10n })
  return { bot, sent }
}

const attr = (name, current) => ({ name, current })

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} health plugin`, function () {
    it('maps health and hunger attributes onto bot.health and bot.food', function () {
      const { bot } = makeBot()
      let healthEvents = 0
      bot.on('health', () => healthEvents++)
      bot._client.emit('update_attributes', { runtime_entity_id: 10n, attributes: [attr('minecraft:health', 15), attr('minecraft:player.hunger', 18), attr('minecraft:player.saturation', 4)] })
      assert.strictEqual(bot.health, 15)
      assert.strictEqual(bot.food, 18)
      assert.strictEqual(bot.foodSaturation, 4)
      assert.ok(healthEvents >= 1)
    })

    it('ignores attribute updates addressed to a different entity', function () {
      const { bot } = makeBot()
      bot._client.emit('update_attributes', { runtime_entity_id: 999n, attributes: [attr('minecraft:health', 3)] })
      assert.notStrictEqual(bot.health, 3)
    })

    it('fires death when health reaches zero and tracks isAlive', function () {
      const { bot } = makeBot()
      bot._client.emit('update_attributes', { runtime_entity_id: 10n, attributes: [attr('minecraft:health', 20)] })
      assert.strictEqual(bot.isAlive, true)
      let died = false
      bot.on('death', () => { died = true })
      bot._client.emit('set_health', { health: 0 })
      assert.strictEqual(bot.health, 0)
      assert.strictEqual(bot.isAlive, false)
      assert.strictEqual(died, true)
    })

    it('drives the respawn handshake after death', function () {
      const { bot, sent } = makeBot()
      bot._client.emit('set_health', { health: 0 })
      assert.strictEqual(bot.isAlive, false)
      bot._client.emit('respawn', { state: 1, position: { x: 1, y: 64, z: 2 } })
      const respawnPkts = sent.filter(p => p.name === 'respawn' || p.name === 'player_action')
      assert.ok(respawnPkts.length >= 1, 'should send a respawn ready / action')
    })
  })
}
