const { Vec3 } = require('vec3')

module.exports = inject

function inject (bot) {
  // play_sound always carries a resolved name -> the named event only (Java emits hardcodedSoundEffectHeard only as a
  // fallback for an UNnamed sound, so a named sound should not also fire it).
  bot._client.on('play_sound', packet => {
    const pt = position(packet.coordinates, 8)
    bot.emit('soundEffectHeard', packet.name, pt, packet.volume, packet.pitch)
  })

  // level_sound_event: a string sound_id is a resolvable name -> soundEffectHeard; a numeric id has no name -> the
  // hardcoded fallback. This mirrors Java's name-resolved/fallback split instead of unconditionally emitting both.
  bot._client.on('level_sound_event', packet => {
    const pt = position(packet.position)
    if (typeof packet.sound_id === 'string') bot.emit('soundEffectHeard', packet.sound_id, pt, 1, 1)
    else bot.emit('hardcodedSoundEffectHeard', packet.sound_id, 'master', pt, 1, 1)
  })
}

function position (value = {}, scale = 1) {
  return new Vec3((value.x ?? 0) / scale, (value.y ?? 0) / scale, (value.z ?? 0) / scale)
}
