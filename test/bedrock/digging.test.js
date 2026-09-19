/* eslint-env mocha */
// Offline tests for Bedrock digging. Breaking rides player_auth_input.block_action (verified against the real-client
// capture), so we check that such a packet serializes against the real protocol, and that bot.dig drives the
// start_break -> predict_break sequence through bot._queueBlockAction.
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const registryLoader = require('prismarine-registry')
const injectDigging = require('../../lib/bedrock_plugins/digging')
const { bedrockTestedVersions } = require('../../lib/version')

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} digging`, function () {
    it('a player_auth_input carrying a block_action serializes', function () {
      const serializer = createSerializer(version)
      const packet = {
        pitch: 0,
        yaw: 0,
        position: { x: 0, y: 65.62, z: 0 },
        move_vector: { x: 0, z: 0 },
        head_yaw: 0,
        input_data: ['block_breaking_delay_enabled', 'block_action'],
        input_mode: 'mouse',
        play_mode: 'screen',
        interaction_model: 'touch',
        interact_rotation: { x: 0, z: 0 },
        tick: 1n,
        delta: { x: 0, y: 0, z: 0 },
        analogue_move_vector: { x: 0, z: 0 },
        camera_orientation: { x: 0, y: 0, z: -1 },
        raw_move_vector: { x: 0, z: 0 },
        block_action: [{ action: 'start_break', position: { x: 1, y: 64, z: 2 }, face: 1 }]
      }
      assert.doesNotThrow(() => serializer.createPacketBuffer({ name: 'player_auth_input', params: packet }), 'block_action player_auth_input must serialize')
    })

    it('bot.dig queues start_break then predict_break for the target block', async function () {
      const bot = new EventEmitter()
      bot.registry = registryLoader('bedrock_' + version)
      bot.game = { gameMode: 'creative' } // duration 0 -> immediate predict_break, fast test
      bot.entity = { position: new Vec3(0, 64, 0), pitch: 0, yaw: 0, eyeHeight: 1.62 }
      bot.lookAt = async () => {}
      bot.blockAt = () => ({ name: 'air' }) // pretend the server confirms instantly
      bot._bedrockWorldSupport = { supported: true }
      const queued = []
      bot._queueBlockAction = (...entries) => { for (const e of entries) queued.push(e) }
      injectDigging(bot)

      const ok = await bot.dig({ position: new Vec3(5, 64, 7) })
      assert.strictEqual(ok, true)
      const actions = queued.map(q => q.action)
      assert.ok(actions.includes('start_break'), 'should start the break')
      assert.ok(actions.includes('predict_break'), 'should predict the break at the end')
      const startEntry = queued.find(q => q.action === 'start_break')
      assert.deepStrictEqual(startEntry.position, { x: 5, y: 64, z: 7 })
    })

    it('stopDigging aborts the break', function () {
      const bot = new EventEmitter()
      bot.registry = registryLoader('bedrock_' + version)
      bot.game = { gameMode: 'survival' }
      bot.entity = { position: new Vec3(0, 64, 0), pitch: 0, yaw: 0, eyeHeight: 1.62 }
      bot.lookAt = async () => {}
      bot.blockAt = () => ({ name: 'dirt' })
      bot._bedrockWorldSupport = { supported: true }
      const queued = []
      bot._queueBlockAction = (...entries) => { for (const e of entries) queued.push(e) }
      injectDigging(bot)
      bot.dig({ position: new Vec3(1, 64, 1) }).catch(() => {}) // do not await; survival duration keeps it running
      assert.strictEqual(bot.isDigging(), true)
      bot.stopDigging()
      assert.strictEqual(bot.isDigging(), false)
      assert.ok(queued.some(q => q.action === 'abort_break'), 'should abort')
    })
  })
}
