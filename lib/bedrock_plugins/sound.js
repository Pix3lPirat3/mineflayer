const { Vec3 } = require('vec3')

module.exports = inject

function inject (bot) {
  bot._client.on('play_sound', packet => {
    const pt = position(packet.coordinates, 8)
    bot.emit('soundEffectHeard', packet.name, pt, packet.volume, packet.pitch)
    // Java emits hardcodedSoundEffectHeard alongside for compatibility; a named sound uses dummy id 0 / 'master'.
    bot.emit('hardcodedSoundEffectHeard', 0, 'master', pt, packet.volume, packet.pitch)
  })

  bot._client.on('level_sound_event', packet => {
    const pt = position(packet.position)
    bot.emit('soundEffectHeard', packet.sound_id, pt, 1, 1)
    bot.emit('hardcodedSoundEffectHeard', packet.sound_id, 'master', pt, 1, 1)
  })
}

function position (value = {}, scale = 1) {
  return new Vec3((value.x ?? 0) / scale, (value.y ?? 0) / scale, (value.z ?? 0) / scale)
}
