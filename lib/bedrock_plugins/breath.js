module.exports = inject

// Oxygen / breath. Bedrock reports the player's air supply in entity metadata ('air', 0..max where max is
// 'max_airdata_max_air', default 300 ticks = 15 bubbles). Expose bot.oxygenLevel on a 0..20 scale (mineflayer's Java
// convention) and emit 'breath' when it changes, so drowning-aware code works on Bedrock.
function inject (bot) {
  const airOf = () => {
    const m = bot.entity && bot.entity.metadata
    if (!m) return undefined
    const air = m.air
    if (air == null) return undefined
    const max = m.max_airdata_max_air || 300
    return Math.max(0, Math.min(20, Math.round((air / max) * 20)))
  }
  Object.defineProperty(bot, 'oxygenLevel', { configurable: true, get: airOf })

  let last
  const check = () => {
    const now = airOf()
    if (now !== undefined && now !== last) { last = now; bot.emit('breath') }
  }
  // The entities plugin applies metadata on set_entity_data; re-read after it to surface a change for the bot.
  bot._client.on('set_entity_data', () => setImmediate(check))
  bot.on('spawn', check)
}
