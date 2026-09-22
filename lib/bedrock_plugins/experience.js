module.exports = inject

function inject (bot) {
  let playerRuntimeId
  bot.experience = {
    level: null,
    points: null,
    progress: null
  }

  bot._client.once('start_game', packet => {
    playerRuntimeId = packet.runtime_entity_id
  })

  bot._client.on('update_attributes', packet => {
    if (playerRuntimeId !== undefined && String(packet.runtime_entity_id) !== String(playerRuntimeId)) return

    const attributes = new Map((packet.attributes || []).map(attribute => [attribute.name, attribute.current]))
    const level = attributes.get('minecraft:player.level')
    const progress = attributes.get('minecraft:player.experience')
    if (level === undefined && progress === undefined) return

    // BDS bundles the level/experience attributes into the same update_attributes it sends for health/hunger every tick,
    // so only emit 'experience' when the value actually changed (Java fires it only on the dedicated experience packet).
    const prevLevel = bot.experience.level
    const prevProgress = bot.experience.progress
    if (level !== undefined) bot.experience.level = level
    if (progress !== undefined) bot.experience.progress = progress
    if (bot.experience.level !== null && bot.experience.progress !== null) {
      bot.experience.points = totalExperience(bot.experience.level, bot.experience.progress)
    }
    if (bot.experience.level !== prevLevel || bot.experience.progress !== prevProgress) bot.emit('experience')
  })
}

function totalExperience (level, progress) {
  let atLevel
  let toNext
  if (level <= 16) {
    atLevel = level * level + 6 * level
    toNext = 2 * level + 7
  } else if (level <= 31) {
    atLevel = 2.5 * level * level - 40.5 * level + 360
    toNext = 5 * level - 38
  } else {
    atLevel = 4.5 * level * level - 162.5 * level + 2220
    toNext = 9 * level - 158
  }
  return Math.floor(atLevel + progress * toNext)
}
