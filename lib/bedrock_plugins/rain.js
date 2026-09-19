module.exports = inject

function inject (bot) {
  bot.isRaining = false
  bot.rainState = 0
  bot.thunderState = 0

  bot._client.once('start_game', packet => {
    bot.rainState = normalizeLevel(packet.rain_level)
    bot.thunderState = normalizeLevel(packet.lightning_level)
    bot.isRaining = bot.rainState > 0
  })

  bot._client.on('level_event', packet => {
    if (packet.event === 'start_rain') updateRain(normalizeLevel(packet.data) || 1)
    if (packet.event === 'stop_rain') updateRain(0)
    if (packet.event === 'start_thunder') updateThunder(normalizeLevel(packet.data) || 1)
    if (packet.event === 'stop_thunder') updateThunder(0)
  })

  function updateRain (level) {
    const wasRaining = bot.isRaining
    bot.rainState = level
    bot.isRaining = level > 0
    bot.emit('weatherUpdate')
    if (bot.isRaining !== wasRaining) bot.emit('rain')
  }

  function updateThunder (level) {
    bot.thunderState = level
    bot.emit('weatherUpdate')
  }
}

function normalizeLevel (level) {
  if (!Number.isFinite(level)) return 0
  return Math.abs(level) > 1 ? level / 65535 : level
}
