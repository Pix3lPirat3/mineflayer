module.exports = inject

const DISPLAY_POSITIONS = {
  list: 0,
  sidebar: 1,
  belowname: 2,
  below_name: 2
}

function inject (bot) {
  const ScoreBoard = require('../scoreboard')(bot)
  const scoreboards = {}
  const entriesById = new Map()

  bot.teamMap ??= {}
  bot.scoreboards = scoreboards
  bot.scoreboard = ScoreBoard.positions

  bot._client.on('set_display_objective', packet => {
    let scoreboard = scoreboards[packet.objective_name]
    if (!scoreboard) {
      scoreboard = new ScoreBoard({ name: packet.objective_name, displayText: packet.display_name })
      scoreboards[packet.objective_name] = scoreboard
      bot.emit('scoreboardCreated', scoreboard)
    } else if (scoreboard.title !== packet.display_name) {
      scoreboard.setTitle(packet.display_name)
      bot.emit('scoreboardTitleChanged', scoreboard)
    }

    const position = DISPLAY_POSITIONS[packet.display_slot.toLowerCase()] ?? packet.display_slot
    bot.emit('scoreboardPosition', position, scoreboard, ScoreBoard.positions[position])
    ScoreBoard.positions[position] = scoreboard
  })

  bot._client.on('remove_objective', packet => {
    const scoreboard = scoreboards[packet.objective_name]
    if (!scoreboard) return
    bot.emit('scoreboardDeleted', scoreboard)
    delete scoreboards[packet.objective_name]
    for (const position of Object.keys(ScoreBoard.positions)) {
      if (ScoreBoard.positions[position] === scoreboard) delete ScoreBoard.positions[position]
    }
  })

  bot._client.on('set_score', packet => {
    const action = packet.action ?? packet.entries?.type
    const entries = Array.isArray(packet.entries) ? packet.entries : packet.entries?.entries
    for (const entry of entries || []) {
      const id = String(entry.scoreboard_id)
      const previous = entriesById.get(id)
      const objectiveName = entry.objective_name ?? previous?.objectiveName
      const scoreboard = scoreboards[objectiveName]
      if (!scoreboard) continue

      if (action === 'remove' || entry.entry_type === 'remove') {
        if (!previous) continue
        entriesById.delete(id)
        bot.emit('scoreRemoved', scoreboard, scoreboard.remove(previous.name))
        continue
      }

      const name = entryName(entry)
      entriesById.set(id, { name, objectiveName })
      bot.emit('scoreUpdated', scoreboard, scoreboard.add(name, entry.score))
    }
  })

  function entryName (entry) {
    if (entry.custom_name) return entry.custom_name
    const player = Object.values(bot.players).find(player => {
      return String(player.entityUniqueId) === String(entry.entity_unique_id)
    })
    return player?.username ?? String(entry.scoreboard_id)
  }
}
