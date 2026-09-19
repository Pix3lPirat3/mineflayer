/* eslint-env mocha */
// Offline behaviour tests for the Bedrock world-state plugins (time, title, rain, experience): each maps an inbound
// packet onto bot state and fires the matching event. Mock packets, no server.
const assert = require('assert')
const { EventEmitter } = require('events')
const registryLoader = require('prismarine-registry')
const { bedrockTestedVersions } = require('../../lib/version')
const injectTime = require('../../lib/bedrock_plugins/time')
const injectTitle = require('../../lib/bedrock_plugins/title')
const injectRain = require('../../lib/bedrock_plugins/rain')
const injectExperience = require('../../lib/bedrock_plugins/experience')

function baseBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  bot._client = new EventEmitter()
  return bot
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} world-state plugins`, function () {
    it('time: set_time updates bot.time and fires time', function () {
      const bot = baseBot(version)
      injectTime(bot)
      let fired = false
      bot.on('time', () => { fired = true })
      bot._client.emit('set_time', { time: 6000 })
      assert.strictEqual(fired, true)
      assert.notStrictEqual(bot.time.timeOfDay, null)
    })

    it('title: set_title fires a title event with the slot name', function () {
      const bot = baseBot(version)
      injectTitle(bot)
      let slot = null
      bot.on('title', (_text, which) => { slot = which })
      bot._client.emit('set_title', { type: 'set_title', text: 'Hello' })
      assert.strictEqual(slot, 'title')
    })

    it('title: action_bar_message fires actionBar', function () {
      const bot = baseBot(version)
      injectTitle(bot)
      let got = false
      bot.on('actionBar', () => { got = true })
      bot._client.emit('set_title', { type: 'action_bar_message', text: 'hi' })
      assert.strictEqual(got, true)
    })

    it('rain: start_rain sets isRaining and fires rain/weatherUpdate', function () {
      const bot = baseBot(version)
      injectRain(bot)
      let rain = false
      let weather = false
      bot.on('rain', () => { rain = true })
      bot.on('weatherUpdate', () => { weather = true })
      assert.strictEqual(bot.isRaining, false)
      bot._client.emit('level_event', { event: 'start_rain', data: 65535 })
      assert.strictEqual(bot.isRaining, true)
      assert.strictEqual(rain, true)
      assert.strictEqual(weather, true)
      bot._client.emit('level_event', { event: 'stop_rain' })
      assert.strictEqual(bot.isRaining, false)
    })

    it('experience: player attributes update bot.experience and fire experience', function () {
      const bot = baseBot(version)
      injectExperience(bot)
      bot._client.emit('start_game', { runtime_entity_id: 10n })
      let fired = false
      bot.on('experience', () => { fired = true })
      bot._client.emit('update_attributes', { runtime_entity_id: 10n, attributes: [{ name: 'minecraft:player.level', current: 7 }, { name: 'minecraft:player.experience', current: 0.5 }] })
      assert.strictEqual(bot.experience.level, 7)
      assert.strictEqual(bot.experience.progress, 0.5)
      assert.strictEqual(fired, true)
    })
  })
}
