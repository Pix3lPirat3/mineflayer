/* eslint-env mocha */
// Bedrock lifecycle and chat against a real offline Bedrock Dedicated Server, the way bedrock-protocol's own
// test/vanilla.js exercises the protocol. The server binary is fetched by minecraft-bedrock-server; if it cannot be
// downloaded or started (offline CI, unsupported platform) the suite skips rather than failing.
const assert = require('assert')
const { once } = require('events')
const mineflayer = require('../..')
const { bedrockTestedVersions } = require('../../lib/version')

let bedrockServer
try { bedrockServer = require('minecraft-bedrock-server') } catch { bedrockServer = null }

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} lifecycle`, function () {
    this.timeout(180000)
    let handle
    let port

    before(async function () {
      if (!bedrockServer) return this.skip()
      const net = require('net')
      port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)) }) })
      try {
        handle = await bedrockServer.startServerAndWait(version, 120000, { 'server-port': port, 'online-mode': false, 'allow-list': false, root: require('os').tmpdir() + '/mfbedrock-' + port })
      } catch (e) {
        console.log('skipping: could not start a Bedrock server:', e.message)
        this.skip()
      }
    })

    after(async () => { handle?.kill?.() })

    it('logs in, spawns with game state, and round-trips chat', async () => {
      const bot = mineflayer.createBot({ edition: 'bedrock', host: '127.0.0.1', port, version: `bedrock_${version}`, username: 'mfbot', offline: true })
      const events = []
      for (const ev of ['connect', 'login', 'game', 'spawn']) bot.on(ev, () => events.push(ev))
      const errors = []
      bot.on('error', e => errors.push(e))
      try {
        await once(bot, 'spawn')
        assert.strictEqual(bot.edition, 'bedrock')
        assert.strictEqual(bot.version, version)
        assert.strictEqual(bot.username, 'mfbot')
        assert.ok(bot.entity, 'bot.entity is set from start_game')
        assert.ok(['survival', 'creative', 'adventure', 'spectator'].includes(bot.game.gameMode), `gameMode ${bot.game.gameMode}`)
        assert.ok(['overworld', 'the_nether', 'the_end'].includes(bot.game.dimension), `dimension ${bot.game.dimension}`)
        assert.strictEqual(typeof bot.health, 'number')
        assert.ok(bot.spawnPoint, 'spawn point is set')
        assert.strictEqual(events[0], 'connect')
        assert.ok(events.indexOf('login') > 0 && events.indexOf('spawn') > events.indexOf('login'))

        const heard = once(bot, 'chat')
        bot.chat('hello from mineflayer')
        const [username, message] = await heard
        assert.strictEqual(username, 'mfbot')
        assert.strictEqual(message, 'hello from mineflayer')

        // the session stays up for a few seconds with the input heartbeat and no packet violation
        await new Promise(resolve => setTimeout(resolve, 4000))
        assert.strictEqual(errors.length, 0, 'no errors during the session: ' + errors.map(e => e.message).join(', '))
        assert.ok(bot.entity, 'still connected after the heartbeat window')
      } finally {
        const ended = once(bot, 'end').catch(() => {})
        bot.end('test done')
        await ended
      }
    })
  })
}
