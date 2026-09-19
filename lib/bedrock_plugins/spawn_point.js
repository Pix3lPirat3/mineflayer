const { Vec3 } = require('vec3')

module.exports = inject

const INVALID_POSITION = -2147483648

function inject (bot) {
  bot.spawnPoint = new Vec3(0, 0, 0)

  bot._client.on('set_spawn_position', packet => {
    const position = validPosition(packet.player_position)
      ? packet.player_position
      : packet.world_position
    if (!validPosition(position)) return
    bot.spawnPoint = new Vec3(position.x, position.y, position.z)
    bot.emit('game')
  })
}

function validPosition (position) {
  return position && position.x !== INVALID_POSITION && position.y !== INVALID_POSITION && position.z !== INVALID_POSITION
}
