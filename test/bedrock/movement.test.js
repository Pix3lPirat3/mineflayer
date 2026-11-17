/* eslint-env mocha */
// Offline test for the Bedrock movement controls in client_input: setControlState records intent, the per-tick
// player_auth_input carries the matching local-frame move_vector and input flags (and serializes), and a
// correct_player_move_prediction applies the server's authoritative position to bot.entity. Server-authoritative
// movement itself is verified live; this guards the packet the client sends and the correction it applies.
const assert = require('assert')
const { EventEmitter } = require('events')
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
const registryLoader = require('prismarine-registry')
const injectInput = require('../../lib/bedrock_plugins/client_input')
const { bedrockTestedVersions } = require('../../lib/version')

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

    it('fires move, with the place before, on each tick the bot moved or turned, and not when it stood still', async function () {
      // As mineflayer does on Java. Before, move fired only on a server correction or a teleport: a walk of sixteen blocks
      // brought three of them, some five blocks apart. Seen live on a Bedrock Dedicated Server 1.26.60.
      const { bot, sent } = makeBot(version) // no physics steps: only what the test changes moves the bot
      const nextSend = () => new Promise(resolve => {
        const count = sent.length
        const check = setInterval(() => { if (sent.length > count) { clearInterval(check); resolve() } }, 5)
      })
      const moves = []
      bot.on('move', from => moves.push({ from: { ...from }, to: { ...bot.entity.position } }))
      bot.emit('spawn') // the first send runs at once and reports where the bot is
      assert.strictEqual(moves.length, 1)

      bot.entity.position.x = 1 // moved since the last send
      await nextSend()
      assert.strictEqual(moves.length, 2)
      assert.strictEqual(moves[1].from.x, 0, 'the place before the move')
      assert.strictEqual(moves[1].to.x, 1)

      bot.entity.yaw = 1 // turned only
      await nextSend()
      assert.strictEqual(moves.length, 3)

      await nextSend() // stood still
      await nextSend()
      assert.strictEqual(moves.length, 3, 'nothing to report')

      // A correction fires move itself; the next send does not announce it again.
      bot._client.emit('correct_player_move_prediction', { position: { x: 5, y: 65.62, z: 0 } })
      assert.strictEqual(moves.length, 4)
      await nextSend()
      assert.strictEqual(moves.length, 4)
      bot._client.emit('close')
    })
  })
}
