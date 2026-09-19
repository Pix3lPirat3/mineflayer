module.exports = inject

function inject (bot) {
  const BossBar = require('../bossbar')(bot.registry)
  const bars = {}
  const colors = ['pink', 'blue', 'red', 'green', 'yellow', 'purple', 'white']
  const overlays = ['progress', 'notched_6', 'notched_10', 'notched_12', 'notched_20']

  bot._client.on('boss_event', packet => {
    const id = String(packet.target_entity_id ?? packet.boss_entity_id)

    if (packet.type === 'show_bar') {
      if (bars[id]) {
        updateBar(bars[id], packet)
        bot.emit('bossBarUpdated', bars[id])
      } else {
        bars[id] = new BossBar(
          id,
          packet.filtered_title || packet.title || '',
          packet.progress ?? packet.bar_progress ?? 0,
          enumIndex(overlays, packet.overlay),
          colorIndex(packet.color),
          0
        )
        bot.emit('bossBarCreated', bars[id])
      }
      return
    }

    const bar = bars[id]
    if (!bar) return
    if (packet.type === 'hide_bar') {
      bot.emit('bossBarDeleted', bar)
      delete bars[id]
      return
    }

    if (packet.type === 'set_bar_progress') bar.health = packet.progress ?? packet.bar_progress
    if (packet.type === 'set_bar_title') bar.title = packet.filtered_title || packet.title || ''
    if (packet.type === 'update_properties' || packet.type === 'texture') {
      bar.color = colorIndex(packet.color)
      bar.dividers = enumIndex(overlays, packet.overlay)
    }
    bot.emit('bossBarUpdated', bar)
  })

  bot._client.on('remove_entity', packet => {
    const id = String(packet.entity_id_self)
    const bar = bars[id]
    if (!bar) return
    bot.emit('bossBarDeleted', bar)
    delete bars[id]
  })

  Object.defineProperty(bot, 'bossBars', {
    get () {
      return Object.values(bars)
    }
  })

  function updateBar (bar, packet) {
    bar.title = packet.filtered_title || packet.title || ''
    bar.health = packet.progress ?? packet.bar_progress ?? 0
    bar.color = colorIndex(packet.color)
    bar.dividers = enumIndex(overlays, packet.overlay)
  }

  function colorIndex (value) {
    if (value === 'rebecca_purple') return colors.indexOf('purple')
    return enumIndex(colors, value)
  }
}

function enumIndex (values, value) {
  if (typeof value === 'number') return value
  const index = values.indexOf(value)
  return index === -1 ? 0 : index
}
