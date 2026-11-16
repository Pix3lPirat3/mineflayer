/* eslint-env mocha */
// Offline test for the Bedrock movement controls in client_input: setControlState records intent, the per-tick
// player_auth_input carries the matching local-frame move_vector and input flags (and serializes), and a
// correct_player_move_prediction applies the server's authoritative position to bot.entity. Server-authoritative
// movement itself is verified live; this guards the packet the client sends and the correction it applies.
const assert = require('assert')
const { EventEmitter } = require('events')
const Vec3 = require('vec3')
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const registryLoader = require('prismarine-registry')
const injectInput = require('../../lib/bedrock_plugins/client_input')
const { bedrockTestedVersions } = require('../../lib/version')

// A bot whose physics engine runs, so each send steps it: it needs a Vec3 position, an inventory and a world.
function makeWalkingBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  bot._client = new EventEmitter()
  bot._client.queue = () => {}
  bot.entity = { position: new Vec3(0, 64, 0), eyeHeight: 1.62, yaw: 0, pitch: 0 }
  bot.inventory = { slots: [] }
  bot.blockAt = () => null
  injectInput(bot)
  return bot
}

// How many physics steps the next send makes. A send makes all of its steps at once, so they are counted until the
// event loop moves on.
function stepsOfNextSend (bot) {
  return new Promise(resolve => {
    let steps = 0
    const onTick = () => {
      if (steps++ === 0) setImmediate(() => { bot.removeListener('physicsTick', onTick); resolve(steps) })
    }
    bot.on('physicsTick', onTick)
  })
}

function makeBot (version) {
  const bot = new EventEmitter()
  bot.registry = registryLoader('bedrock_' + version)
  const sent = []
  bot._client = new EventEmitter()
  bot._client.queue = (name, params) => sent.push({ name, params })
  bot.entity = { position: { x: 0, y: 64, z: 0 }, eyeHeight: 1.62, yaw: 0, pitch: 0 }
  injectInput(bot)
  return { bot, sent }
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} movement controls`, function () {
    const serializer = createSerializer(version)

    afterEach(function () { /* timers are unref'd; nothing to clean */ })

    it('setControlState / getControlState / clearControlStates and unknown control throws', function () {
      const { bot } = makeBot(version)
      assert.strictEqual(bot.getControlState('forward'), false)
      bot.setControlState('forward', true)
      assert.strictEqual(bot.getControlState('forward'), true)
      bot.clearControlStates()
      assert.strictEqual(bot.getControlState('forward'), false)
      assert.throws(() => bot.setControlState('teleport', true))
    })

    it('the auth-input tick carries the move_vector and input flags for the active controls, and serializes', function () {
      const { bot, sent } = makeBot(version)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      bot.emit('spawn') // starts the input loop; send() runs once synchronously
      const pkt = sent.find(p => p.name === 'player_auth_input')
      assert.ok(pkt, 'a player_auth_input is sent')
      assert.deepStrictEqual(pkt.params.move_vector, { x: 0, z: 1 }, 'forward is +z in the local frame')
      const flags = Array.isArray(pkt.params.input_data) ? pkt.params.input_data : Object.keys(pkt.params.input_data).filter(k => pkt.params.input_data[k])
      assert.ok(flags.includes('up'), 'forward sets the up flag')
      assert.ok(flags.includes('sprinting'), 'sprint sets the sprinting flag')
      assert.doesNotThrow(() => serializer.createPacketBuffer(pkt), 'player_auth_input must serialize')
      bot._client.emit('close')
    })

    it('applies correct_player_move_prediction to bot.entity.position (feet from eye level)', function () {
      const { bot } = makeBot(version)
      bot._client.emit('correct_player_move_prediction', { position: { x: 10, y: 65.62, z: -4 } })
      assert.strictEqual(bot.entity.position.x, 10)
      assert.ok(Math.abs(bot.entity.position.y - 64) < 1e-6, 'feet = eye - eyeHeight')
      assert.strictEqual(bot.entity.position.z, -4)
    })

    it('after the event loop stalls, a send makes up no more than two ticks of movement', async function () {
      // The server got no input while the loop was busy and kept the player still. Making up every missed tick at once
      // (up to 8) put a walking bot a block or more ahead of it; the server pulled the bot back a second later, after
      // mineflayer-pathfinder had already counted its goal as reached. Seen live on a Bedrock Dedicated Server 1.26.63.
      const bot = makeWalkingBot(version)
      bot.setControlState('forward', true)
      bot.emit('spawn') // the first send runs at once
      const realNow = Date.now
      Date.now = () => realNow() + 600 // twelve ticks go by before the next send
      try {
        assert.strictEqual(await stepsOfNextSend(bot), 2)
      } finally {
        Date.now = realNow
        bot._client.emit('close')
      }
    })
  })
}
