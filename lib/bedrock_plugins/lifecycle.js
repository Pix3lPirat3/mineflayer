const { Vec3 } = require('vec3')
const conv = require('../conversions')

module.exports = inject

const PLAYER_HEIGHT = 1.8
const PLAYER_WIDTH = 0.6
const PLAYER_EYE_HEIGHT = 1.62

function inject (bot) {
  const Entity = require('prismarine-entity')(bot.registry)
  let respawnPending = false
  let loggedIn = false

  bot.quit = reason => bot.end(reason ?? 'disconnect.quitting')
  bot.players = {}
  bot.uuidToUsername = {}
  bot.entities = {}

  bot._client.once('start_game', packet => {
    const entityId = Number(packet.runtime_entity_id)
    const position = packet.player_position ?? packet.spawn
    const entity = new Entity(entityId)
    const profile = bot._client.profile || {}

    entity.position = new Vec3(position.x, position.y - PLAYER_EYE_HEIGHT, position.z)
    entity.yaw = conv.fromNotchianYaw(packet.rotation?.z ?? 0)
    entity.pitch = conv.fromNotchianPitch(packet.rotation?.x ?? 0)
    entity.username = profile.name || bot._client.username || bot.username
    entity.uuid = profile.uuid
    entity.uniqueId = packet.entity_id
    entity.type = 'player'
    entity.name = 'player'
    entity.height = PLAYER_HEIGHT
    entity.width = PLAYER_WIDTH
    entity.eyeHeight = PLAYER_EYE_HEIGHT

    bot.username = entity.username
    bot.entity = entity
    bot.entities[entityId] = entity
    bot.player = bot.players[entity.username] || {
      username: entity.username,
      uuid: entity.uuid
    }
    bot.player.entity = entity
    bot.players[entity.username] = bot.player
    if (entity.uuid) bot.uuidToUsername[entity.uuid] = entity.username
    loggedIn = true
    bot.emit('login')
  })

  bot._client.on('spawn', () => bot.emit('spawn'))
  bot.on('spawn', () => { respawnPending = false })
  bot._client.on('respawn', packet => {
    const position = packet.position ?? (packet.x != null ? packet : null)
    if (!bot.entity || !position) return
    bot.entity.position.set(position.x, position.y - bot.entity.eyeHeight, position.z)
    if (packet.state === 1 || packet.state === 'ready_to_spawn') {
      bot.emit('forcedMove')
      if (!bot.isAlive && !respawnPending) {
        respawnPending = true
        bot.emit('respawn')
      }
    }
  })
  bot._client.on('kick', packet => {
    bot.emit('kicked', packet.message ?? packet.reason ?? packet, loggedIn)
  })
}
