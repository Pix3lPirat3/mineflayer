const { Vec3 } = require('vec3')

module.exports = inject

function inject (bot) {
  bot._client.on('play_sound', packet => {
    bot.emit('soundEffectHeard', packet.name, position(packet.coordinates, 8), packet.volume, packet.pitch)
  })

  bot._client.on('level_sound_event', packet => {
    bot.emit('soundEffectHeard', packet.sound_id, position(packet.position), 1, 1)
  })
}

function position (value = {}, scale = 1) {
  return new Vec3((value.x ?? 0) / scale, (value.y ?? 0) / scale, (value.z ?? 0) / scale)
}
