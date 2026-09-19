/*
 * A Bedrock bot: joins an offline Bedrock server, greets, and echoes chat.
 *
 * node examples/bedrock_chat.js <host> [port] [version]
 *
 * Bedrock support covers connection lifecycle, game state, health, time, spawn point and chat for now.
 */
const mineflayer = require('mineflayer')

if (process.argv.length < 3 || process.argv.length > 5) {
  console.log('Usage : node bedrock_chat.js <host> [<port>] [<version>]')
  process.exit(1)
}

const bot = mineflayer.createBot({
  edition: 'bedrock',
  host: process.argv[2],
  port: parseInt(process.argv[3]) || 19132,
  version: process.argv[4] || 'bedrock_1.26.45',
  username: 'mineflayer',
  offline: true
})

bot.once('spawn', () => {
  console.log(`spawned as ${bot.username} on ${bot.version}, ${bot.game.gameMode} in ${bot.game.dimension}, health ${bot.health}`)
  bot.chat('hello from mineflayer')
})

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  bot.chat(`${username} said: ${message}`)
})

bot.on('kicked', console.log)
bot.on('error', console.log)
