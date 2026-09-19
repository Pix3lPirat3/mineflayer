/* eslint-env mocha */
// Offline test for the Bedrock blocks plugin's world-support guard. With a registry that has remapped its block tables
// by state hash (the blockHashes path), a hashed start_game must enable the world; without the remap the guard must
// refuse it with a reason rather than silently returning wrong blocks. Uses the captured 1.26.45 start_game fixture.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const registryLoader = require('prismarine-registry')
const injectBlocks = require('../../lib/bedrock_plugins/blocks')

const version = '1.26.45'
const fixtureDir = path.join(__dirname, '..', '..', '..', 'prismarine-chunk-bedrock126', 'test', 'bedrock', 'fixtures', version)
const reviver = (k, v) => typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v

function makeBot (registry) {
  const bot = new EventEmitter()
  bot.registry = registry
  bot.version = version
  bot._warn = () => {}
  bot._client = new EventEmitter()
  injectBlocks(bot)
  return bot
}

describe('bedrock ' + version + ' blocks world-support guard', function () {
  let startGame
  before(function () {
    const f = path.join(fixtureDir, 'start_game.json')
    if (!fs.existsSync(f)) return this.skip()
    startGame = JSON.parse(fs.readFileSync(f, 'utf8'), reviver)
    const probe = registryLoader('bedrock_' + version)
    if (!probe.handleStartGame) this.skip()
  })

  it('enables the world when the registry has remapped block tables by hash', function () {
    const registry = registryLoader('bedrock_' + version)
    registry.handleStartGame(startGame)
    // sanity: the remap keyed blocksByStateId by hash
    if (registry.blocksByStateId[registry.blocksByName.stone.defaultState]?.name !== 'stone') this.skip()
    const bot = makeBot(registry)
    bot._client.emit('start_game', startGame)
    assert.strictEqual(bot._bedrockWorldSupport.supported, true)
    assert.strictEqual(bot._bedrockWorldSupport.reason, null)
    assert.strictEqual(typeof bot.blockAt, 'function')
  })

  it('refuses the world (with a reason) when the registry has not remapped by hash', function () {
    const registry = registryLoader('bedrock_' + version) // no handleStartGame -> index-ordered tables
    const bot = makeBot(registry)
    bot._client.emit('start_game', startGame)
    assert.strictEqual(bot._bedrockWorldSupport.supported, false)
    assert.ok(bot._bedrockWorldSupport.reason, 'a reason should be given')
  })

  // findBlock/findBlocks correctness is verified live against BDS (string, array and predicate matchers all locate
  // real blocks); here we only guard that inject wires them and that they are safe on an empty (unloaded) world.
  it('wires findBlock/findBlocks and returns nothing safely on an empty world', function () {
    const registry = registryLoader('bedrock_' + version)
    registry.handleStartGame(startGame)
    const bot = makeBot(registry)
    const { Vec3 } = require('vec3')
    bot.entity = { position: new Vec3(0, 64, 0) }
    assert.strictEqual(typeof bot.findBlock, 'function')
    assert.strictEqual(typeof bot.findBlocks, 'function')
    assert.deepStrictEqual(bot.findBlocks({ matching: 'stone', maxDistance: 4 }), [])
    assert.strictEqual(bot.findBlock({ matching: 'stone', maxDistance: 4 }), null)
    assert.doesNotThrow(() => bot.findBlocks({ matching: (b) => b && b.name === 'stone', maxDistance: 4 }))
  })
})
