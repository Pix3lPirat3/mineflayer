/* eslint-env mocha */
// Offline behaviour tests for the Bedrock game and scoreboard plugins: start_game populates bot.game and later
// packets update the game mode; scoreboard objectives are created and removed. Mock packets, no server.
const assert = require('assert')
const { EventEmitter } = require('events')
const registryLoader = require('prismarine-registry')
const { bedrockTestedVersions } = require('../../lib/version')
const injectGame = require('../../lib/bedrock_plugins/game')
const injectScoreboard = require('../../lib/bedrock_plugins/scoreboard')

function baseBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  bot.version = version
  bot._warn = () => {}
  bot._client = new EventEmitter()
  bot._client.queue = () => {}
  return bot
}

const startGame = { player_gamemode: 1, world_gamemode: 0, dimension: 0, difficulty: 2, hardcore: false, generator: 1 }

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} game plugin`, function () {
    it('populates bot.game from start_game and fires game', async function () {
      const bot = baseBot(version)
      injectGame(bot)
      let fired = false
      bot.on('game', () => { fired = true })
      bot._client.emit('start_game', startGame)
      assert.strictEqual(bot.game.gameMode, 'creative')
      assert.strictEqual(bot.game.dimension, 'overworld')
      assert.strictEqual(bot.game.difficulty, 'normal')
      await new Promise(resolve => queueMicrotask(resolve))
      assert.strictEqual(fired, true)
    })

    it('updates the game mode on set_player_game_type', function () {
      const bot = baseBot(version)
      injectGame(bot)
      bot._client.emit('start_game', startGame)
      bot._client.emit('set_player_game_type', { gamemode: 0 })
      assert.strictEqual(bot.game.gameMode, 'survival')
    })
  })

  describe(`bedrock ${version} scoreboard plugin`, function () {
    it('creates and removes a scoreboard objective', function () {
      const bot = baseBot(version)
      injectScoreboard(bot)
      let created = null
      let deleted = false
      bot.on('scoreboardCreated', (sb) => { created = sb })
      bot.on('scoreboardDeleted', () => { deleted = true })
      bot._client.emit('set_display_objective', { objective_name: 'obj1', display_name: 'Stats', display_slot: 'sidebar' })
      assert.ok(created, 'scoreboardCreated should fire')
      assert.ok(bot.scoreboards.obj1, 'objective tracked')
      bot._client.emit('remove_objective', { objective_name: 'obj1' })
      assert.strictEqual(deleted, true)
      assert.ok(!bot.scoreboards.obj1, 'objective removed')
    })
  })
}
