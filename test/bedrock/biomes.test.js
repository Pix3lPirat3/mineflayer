/* eslint-env mocha */
// Offline test that the Bedrock blocks plugin reads a chunk column's biomes. A current server sends a chunk in
// subchunk-request mode: the level_chunk payload has no block sections, only the column's biomes (and its block
// entities), and the blocks come later by subchunk_request. The biomes were never read from it, so every spot
// answered with biome 0. Seen on a Bedrock Dedicated Server 1.26.63, whose flat world sends biome 1 (plains).
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const registryLoader = require('prismarine-registry')
const injectBlocks = require('../../lib/bedrock_plugins/blocks')
const { bedrockTestedVersions } = require('../../lib/version')

function makeBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  bot.version = version
  bot.game = { minY: -64, height: 384 }
  bot._warn = () => {}
  bot._client = new EventEmitter()
  bot._client.queue = () => {}
  injectBlocks(bot)
  // What mineflayer does with start_game: the registry builds its runtime block table, then the plugin hears it.
  const startGame = { dimension: 'overworld', block_network_ids_are_hashes: false }
  bot.registry.handleStartGame(startGame)
  bot._client.emit('start_game', startGame)
  assert.ok(bot._bedrockWorldSupport.supported, bot._bedrockWorldSupport.reason)
  return bot
}

// The payload a server sends with a chunk in subchunk-request mode: the column's biomes, then no border blocks.
function biomePayload (registry, biomes) {
  const Chunk = require('prismarine-chunk')(registry)
  const column = new Chunk({ x: 0, z: 0 })
  for (let y = -64; y < 320; y += 16) column.setBiomeId(new Vec3(0, y, 0), 0)
  for (const [x, y, z, id] of biomes) column.setBiomeId(new Vec3(x, y, z), id)
  return column.networkEncodeNoCache()
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} biomes`, function () {
    for (const [mode, fields] of [['LIMITED (-1)', { sub_chunk_count: -1, highest_subchunk_count: 24 }], ['the 0-with-highest form', { sub_chunk_count: 0, highest_subchunk_count: 24 }]]) {
      it(`reads the biomes of a chunk sent in subchunk-request mode, ${mode}`, async function () {
        const bot = makeBot(version)
        const payload = await biomePayload(bot.registry, [[1, 64, 1, 1], [5, -30, 9, 192]])
        bot._client.emit('level_chunk', { x: 0, z: 0, dimension: 0, cache_enabled: false, payload, ...fields })
        // The column joins the world once every section it asked for has answered (here all of them as air).
        const entries = Array.from({ length: 24 }, (_, dy) => ({ dx: 0, dy, dz: 0, result: 'success_all_air' }))
        bot._client.emit('subchunk', { cache_enabled: false, origin: { x: 0, y: -4, z: 0 }, entries })
        await new Promise(resolve => setImmediate(resolve))
        assert.strictEqual(bot.world.getBiome(new Vec3(1, 64, 1)).id, 1)
        assert.strictEqual(bot.world.getBiome(new Vec3(5, -30, 9)).id, 192)
        assert.strictEqual(bot.world.getBiome(new Vec3(8, 64, 8)).id, 0)
      })
    }
  })
}
