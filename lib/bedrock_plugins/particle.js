const { Vec3 } = require('vec3')

module.exports = inject

function inject (bot) {
  // Bedrock's registry has no particles table, so the prismarine Particle class (which indexes registry.particles)
  // throws here; build a plain, Java-shaped particle object instead and enrich id/name from the registry when it exists.
  const buildParticle = (name, position, velocity = new Vec3(0, 0, 0)) => {
    const particle = { id: name, name, position, count: 1, velocity, longDistance: false }
    try {
      const reg = bot.registry.particlesByName || bot.registry.particles
      const info = reg && reg[name]
      if (info) { particle.id = info.id ?? name; particle.name = info.name ?? name }
    } catch { /* no particle registry - keep the raw name */ }
    return particle
  }

  bot._client.on('spawn_particle_effect', packet => {
    let position = new Vec3(packet.position.x, packet.position.y, packet.position.z)
    if (String(packet.entity_id) !== '-1') {
      const entity = Object.values(bot.entities).find(entity => String(entity.uniqueId) === String(packet.entity_id))
      if (entity) position = entity.position.plus(position)
    }
    bot.emit('particle', buildParticle(packet.particle_name, position))
  })

  // The bulk of gameplay particles (block break, crit, splash, crop growth, ...) ride level_event with a numeric event
  // id that maps to a 'particle_*' name (2000+), not spawn_particle_effect. Emit them as 'particle' too so a bot sees the
  // same particle stream Java does. level_event also carries sounds/weather/block-break events; those are handled by the
  // sound/rain/block_actions plugins - here we act only on the particle_* names.
  bot._client.on('level_event', packet => {
    const name = packet.event
    if (typeof name !== 'string' || !name.startsWith('particle')) return
    const position = packet.position ? new Vec3(packet.position.x, packet.position.y, packet.position.z) : new Vec3(0, 0, 0)
    bot.emit('particle', buildParticle(name, position))
  })
}
