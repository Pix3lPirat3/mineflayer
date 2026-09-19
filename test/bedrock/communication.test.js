/* eslint-env mocha */
// Offline behaviour tests for the Bedrock chat and boss-bar plugins: inbound text packets fan out to the right
// chat/message/actionBar/whisper events, and boss_event packets create, update and delete boss bars.
const assert = require('assert')
const { EventEmitter } = require('events')
const registryLoader = require('prismarine-registry')
const { bedrockTestedVersions } = require('../../lib/version')
const injectChat = require('../../lib/bedrock_plugins/chat')
const injectBossBar = require('../../lib/bedrock_plugins/boss_bar')

function baseBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  bot.version = version
  bot._warn = () => {}
  bot._client = new EventEmitter()
  bot._client.queue = () => {}
  return bot
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} chat plugin`, function () {
    it('emits chat for a player chat message', function () {
      const bot = baseBot(version)
      injectChat(bot, {})
      let got = null
      bot.on('chat', (username, message) => { got = { username, message } })
      bot._client.emit('text', { type: 'chat', message: 'Hello world', source_name: 'Steve' })
      assert.ok(got)
      assert.strictEqual(got.username, 'Steve')
      assert.strictEqual(got.message, 'Hello world')
    })

    it('emits actionBar for a popup message', function () {
      const bot = baseBot(version)
      injectChat(bot, {})
      let got = false
      bot.on('actionBar', () => { got = true })
      bot._client.emit('text', { type: 'popup', message: 'tip' })
      assert.strictEqual(got, true)
    })

    it('emits whisper for a whisper message', function () {
      const bot = baseBot(version)
      injectChat(bot, {})
      let who = null
      bot.on('whisper', (username, message) => { who = { username, message } })
      bot._client.emit('text', { type: 'whisper', message: 'psst', source_name: 'Alex' })
      assert.ok(who)
      assert.strictEqual(who.username, 'Alex')
    })
  })

  describe(`bedrock ${version} boss_bar plugin`, function () {
    it('creates, updates and deletes a boss bar', function () {
      const bot = baseBot(version)
      injectBossBar(bot)
      let created = null
      let updated = false
      let deleted = false
      bot.on('bossBarCreated', (bar) => { created = bar })
      bot.on('bossBarUpdated', () => { updated = true })
      bot.on('bossBarDeleted', () => { deleted = true })
      bot._client.emit('boss_event', { type: 'show_bar', target_entity_id: 5n, title: 'The Boss', progress: 0.8, overlay: 0, color: 0 })
      assert.ok(created, 'bossBarCreated should fire')
      bot._client.emit('boss_event', { type: 'set_bar_progress', target_entity_id: 5n, progress: 0.4 })
      assert.strictEqual(updated, true)
      bot._client.emit('boss_event', { type: 'hide_bar', target_entity_id: 5n })
      assert.strictEqual(deleted, true)
    })
  })
}
