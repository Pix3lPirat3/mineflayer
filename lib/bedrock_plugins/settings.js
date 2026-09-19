const assert = require('assert')

module.exports = inject

const viewDistances = {
  far: 12,
  normal: 10,
  short: 8,
  tiny: 6
}

function inject (bot, options) {
  bot.settings = {
    chat: options.chat || 'enabled',
    colorsEnabled: options.colorsEnabled ?? true,
    viewDistance: options.viewDistance || 'far',
    difficulty: options.difficulty ?? 2,
    skinParts: options.skinParts || {
      showCape: true,
      showJacket: true,
      showLeftSleeve: true,
      showRightSleeve: true,
      showLeftPants: true,
      showRightPants: true,
      showHat: true
    },
    mainHand: options.mainHand || 'right',
    enableTextFiltering: options.enableTextFiltering || false,
    enableServerListing: options.enableServerListing ?? true,
    particleStatus: options.particleStatus || 'all'
  }
  bot._client.viewDistance = requestedViewDistance(bot.settings.viewDistance)

  bot.setSettings = settings => {
    const next = { ...bot.settings, ...settings }
    const requested = requestedViewDistance(next.viewDistance)
    Object.assign(bot.settings, settings)

    bot._client.viewDistance = requested
    const packet = { chunk_radius: requested }
    if (bot.registry.version['>=']('1.26.40')) packet.max_radius = requested
    if (typeof bot._client.queue === 'function') bot._client.queue('request_chunk_radius', packet)
    else bot._client.write('request_chunk_radius', packet)
  }

  function requestedViewDistance (value) {
    const requested = typeof value === 'string' ? viewDistances[value] : value
    assert.ok(Number.isInteger(requested) && requested > 0, `invalid view distance setting: ${value}`)
    return requested
  }
}
