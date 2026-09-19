const { Vec3 } = require('vec3')

module.exports = inject

function inject (bot) {
  const Particle = require('../particle')(bot.registry)

  bot._client.on('spawn_particle_effect', packet => {
    let position = new Vec3(packet.position.x, packet.position.y, packet.position.z)
    if (String(packet.entity_id) !== '-1') {
      const entity = Object.values(bot.entities).find(entity => String(entity.uniqueId) === String(packet.entity_id))
      if (entity) position = entity.position.plus(position)
    }

    bot.emit('particle', new Particle(
      packet.particle_name,
      position,
      new Vec3(0, 0, 0)
    ))
  })
}
