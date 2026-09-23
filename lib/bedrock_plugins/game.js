module.exports = inject

const difficultyNames = ['peaceful', 'easy', 'normal', 'hard']
const dimensionNames = {
  0: 'overworld',
  1: 'the_nether',
  2: 'the_end',
  overworld: 'overworld',
  nether: 'the_nether',
  end: 'the_end',
  the_nether: 'the_nether',
  the_end: 'the_end'
}

function inject (bot) {
  let playerUniqueId
  bot.game = { gameRules: {} }

  bot._client.once('start_game', packet => {
    initializeRegistry(bot.registry, packet)
    playerUniqueId = packet.entity_id
    bot.game.levelType = packet.generator === 2 || packet.generator === 'flat' ? 'flat' : 'default'
    bot.game.gameMode = normalizeGameMode(packet.player_gamemode, packet.world_gamemode)
    bot.game.hardcore = Boolean(packet.hardcore)
    bot.game.dimension = normalizeDimension(bot, packet.dimension)
    bot.game.difficulty = difficultyNames[packet.difficulty] || 'normal'
    bot.game.maxPlayers = 0
    bot.game.serverBrand = packet.engine || packet.game_version || 'bedrock'
    bot.game.serverViewDistance = null
    updateDimensionBounds(bot)
    queueMicrotask(() => bot.emit('game'))
  })

  bot._client.on('set_difficulty', packet => {
    bot.game.difficulty = difficultyNames[packet.difficulty] || bot.game.difficulty
  })

  bot._client.on('set_player_game_type', packet => updateGameMode(packet.gamemode))
  bot._client.on('update_player_game_type', packet => {
    if (playerUniqueId !== undefined && String(packet.player_unique_id) !== String(playerUniqueId)) return
    updateGameMode(packet.gamemode)
  })

  bot._client.on('change_dimension', packet => {
    bot.game.dimension = normalizeDimension(bot, packet.dimension)
    updateDimensionBounds(bot)
    bot.emit('game')
  })

  bot._client.on('chunk_radius_update', packet => {
    bot.game.serverViewDistance = packet.chunk_radius
  })

  bot._client.on('game_rules_changed', packet => {
    for (const rule of packet.rules || []) bot.game.gameRules[rule.name] = rule.value
  })

  function updateGameMode (gameMode) {
    const normalized = normalizeGameMode(gameMode, bot.game.gameMode)
    if (normalized === bot.game.gameMode) return
    bot.game.gameMode = normalized
    bot.emit('game')
  }
}

function initializeRegistry (registry, packet) {
  if (!registry.blockStates) return
  const canonicalItems = {
    items: registry.items,
    itemsArray: registry.itemsArray,
    itemsByName: registry.itemsByName
  }
  registry.handleStartGame({ ...packet, itemstates: [] })
  Object.assign(registry, canonicalItems)
}

function normalizeGameMode (gameMode, fallback = 'survival') {
  if (gameMode === 5 || gameMode === 'fallback') return normalizeGameMode(fallback)
  if (gameMode === 0 || gameMode === 'survival') return 'survival'
  if (gameMode === 1 || gameMode === 'creative') return 'creative'
  if (gameMode === 2 || gameMode === 'adventure') return 'adventure'
  if (gameMode === 3 || gameMode === 4 || gameMode === 6 || String(gameMode).includes('spectator')) return 'spectator'
  return 'survival'
}

function normalizeDimension (bot, dimension) {
  const name = typeof dimension === 'string' ? dimension.replace('minecraft:', '') : dimension
  const resolved = dimensionNames[name]
  if (resolved == null) {
    if (bot && bot._warn) bot._warn(`unknown bedrock dimension ${JSON.stringify(dimension)}; defaulting to overworld`)
    return 'overworld'
  }
  return resolved
}

function updateDimensionBounds (bot) {
  if (bot.game.dimension === 'the_nether') {
    bot.game.minY = 0
    bot.game.height = 128
  } else if (bot.game.dimension === 'overworld' && bot.registry.version['>=']('1.18.0')) {
    bot.game.minY = -64
    bot.game.height = 384
  } else {
    bot.game.minY = 0
    bot.game.height = 256
  }
}
