const conv = require('../conversions')

module.exports = inject

function inject (bot) {
  const Entity = require('prismarine-entity')(bot.registry)
  const ChatMessage = require('prismarine-chat')(bot.registry)
  const uniqueToRuntime = new Map()

  bot._playerFromUUID = uuid => Object.values(bot.players).find(player => player.uuid === uuid)

  bot.findPlayer = bot.findPlayers = filter => {
    const matches = Object.values(bot.entities).filter(entity => {
      if (entity.type !== 'player') return false
      if (filter == null) return true
      if (filter instanceof RegExp) return filter.test(entity.username)
      if (typeof filter === 'function') return filter(entity)
      if (typeof filter === 'string') return entity.username?.toLowerCase() === filter.toLowerCase()
      return false
    })

    if (typeof filter !== 'string') return matches
    if (matches.length === 0) return null
    return matches.length === 1 ? matches[0] : matches
  }

  bot.nearestEntity = (match = () => true) => {
    if (!bot.entity) return null
    let nearest = null
    let nearestDistance = Infinity
    for (const entity of Object.values(bot.entities)) {
      if (entity === bot.entity || !entity.isValid || !match(entity)) continue
      const distance = bot.entity.position.distanceSquared(entity.position)
      if (distance < nearestDistance) {
        nearest = entity
        nearestDistance = distance
      }
    }
    return nearest
  }

  bot._client.on('player_list', packet => {
    const records = Array.isArray(packet.records) ? packet.records : packet.records.records
    const packetType = Array.isArray(packet.records) ? null : packet.records.type
    for (const record of records) {
      const type = record.type || packetType
      if (type === 'add') addPlayerListRecord(record)
      if (type === 'remove') removePlayerListRecord(record.uuid)
    }
  })

  bot._client.on('add_player', packet => {
    const runtimeId = runtimeNumber(packet.runtime_id ?? packet.runtime_entity_id)
    if (runtimeId == null) return
    const entity = fetchEntity(runtimeId)
    const player = bot._playerFromUUID(packet.uuid) || bot.players[packet.username]
    const uniqueId = packet.unique_id ?? packet.entity_id_self

    setPlayerEntity(entity, packet.username, packet.uuid)
    setTransform(entity, packet)
    entity.uniqueId = uniqueId
    entity.gamemode = packet.gamemode
    applyMetadata(entity, packet.metadata)
    uniqueToRuntime.set(String(uniqueId), runtimeId)

    if (player) player.entity = entity
    bot.emit('entitySpawn', entity)
  })

  bot._client.on('add_entity', packet => {
    const runtimeId = runtimeNumber(packet.runtime_id ?? packet.runtime_entity_id)
    if (runtimeId == null) return
    const entity = fetchEntity(runtimeId)
    const uniqueId = packet.unique_id ?? packet.entity_id_self

    setEntityData(entity, packet.entity_type)
    setTransform(entity, packet)
    entity.uniqueId = uniqueId
    applyMetadata(entity, packet.metadata)
    applyAttributes(entity, packet.attributes)
    uniqueToRuntime.set(String(uniqueId), runtimeId)
    bot.emit('entitySpawn', entity)
  })

  bot._client.on('add_item_entity', packet => {
    const runtimeId = runtimeNumber(packet.runtime_entity_id)
    if (runtimeId == null) return
    const entity = fetchEntity(runtimeId)

    setEntityData(entity, 'minecraft:item')
    setPosition(entity, packet.position ?? coordinates(packet, ''))
    setVelocity(entity, packet.velocity ?? coordinates(packet, 'speed_'))
    entity.uniqueId = packet.entity_id_self
    entity.item = bot._bedrockItemFromNotch?.(packet.item) || null
    entity.getDroppedItem = () => entity.item
    applyMetadata(entity, packet.metadata)
    uniqueToRuntime.set(String(entity.uniqueId), runtimeId)
    bot.emit('entitySpawn', entity)
  })

  bot._client.on('take_item_entity', packet => {
    const collected = entityForRuntime(packet.runtime_entity_id)
    const collector = entityForRuntime(packet.target)
    if (collector && collected) bot.emit('playerCollect', collector, collected)
  })

  bot._client.on('remove_entity', packet => {
    const runtimeId = uniqueToRuntime.get(String(packet.entity_id_self))
    if (runtimeId == null) return
    uniqueToRuntime.delete(String(packet.entity_id_self))
    removeEntity(runtimeId)
  })

  bot._client.on('move_entity', packet => {
    const entity = entityForRuntime(packet.runtime_entity_id)
    if (!entity) return
    setPosition(entity, packet.position)
    if (packet.rotation) {
      entity.yaw = conv.fromNotchianYaw(packet.rotation.yaw)
      entity.pitch = conv.fromNotchianPitch(packet.rotation.pitch)
      entity.headYaw = conv.fromNotchianYaw(packet.rotation.head_yaw)
    }
    bot.emit('entityMoved', entity)
  })

  bot._client.on('move_player', packet => {
    const entity = entityForRuntime(packet.runtime_id)
    if (!entity) return
    if (packet.position) {
      entity.position.set(packet.position.x, packet.position.y - (entity.eyeHeight || 1.62), packet.position.z)
    }
    entity.yaw = conv.fromNotchianYaw(packet.yaw)
    entity.pitch = conv.fromNotchianPitch(packet.pitch)
    entity.headYaw = conv.fromNotchianYaw(packet.head_yaw)
    entity.onGround = packet.on_ground
    bot.emit('entityMoved', entity)
  })

  bot._client.on('move_entity_delta', packet => {
    const entity = entityForRuntime(packet.runtime_entity_id)
    if (!entity) return
    if (packet.x != null) entity.position.x = packet.x
    if (packet.y != null) entity.position.y = packet.y
    if (packet.z != null) entity.position.z = packet.z
    if (packet.rot_x != null) entity.pitch = conv.fromNotchianPitchByte(packet.rot_x)
    if (packet.rot_y != null) entity.yaw = conv.fromNotchianYawByte(packet.rot_y)
    if (packet.rot_z != null) entity.headYaw = conv.fromNotchianYawByte(packet.rot_z)
    entity.onGround = packet.on_ground
    bot.emit('entityMoved', entity)
  })

  bot._client.on('set_entity_motion', packet => {
    const entity = entityForRuntime(packet.runtime_entity_id)
    if (!entity) return
    setVelocity(entity, packet.velocity)
  })

  bot._client.on('set_entity_data', packet => {
    const entity = entityForRuntime(packet.runtime_entity_id)
    if (!entity) return
    const wasSneaking = Boolean(entity.metadata.flags?.sneaking)
    applyMetadata(entity, packet.metadata)
    const isSneaking = Boolean(entity.metadata.flags?.sneaking)
    if (wasSneaking !== isSneaking) {
      if (entity.type === 'player') {
        entity.height = isSneaking ? 1.5 : 1.8
        entity.eyeHeight = isSneaking ? 1.27 : 1.62
      }
      bot.emit(isSneaking ? 'entityCrouch' : 'entityUncrouch', entity)
    }
    if (entity === bot.entity) updateBreath(packet.metadata)
    bot.emit('entityUpdate', entity)
  })

  bot._client.on('entity_event', packet => {
    const entity = entityForRuntime(packet.runtime_entity_id)
    if (!entity) return
    const event = {
      hurt_animation: 'entityHurt',
      death_animation: 'entityDead',
      tame_fail: 'entityTaming',
      tame_success: 'entityTamed',
      shake_wet: 'entityShakingOffWater',
      use_item: 'entityEat',
      eating_item: 'entityEat',
      eat_grass_animation: 'entityEatingGrass'
    }[packet.event_id]
    if (event) bot.emit(event, entity)
  })

  bot._client.on('animate', packet => {
    const entity = entityForRuntime(packet.runtime_entity_id)
    if (!entity) return
    const event = {
      swing_arm: 'entitySwingArm',
      wake_up: 'entityWake',
      critical_hit: 'entityCriticalEffect',
      magic_critical_hit: 'entityMagicCriticalEffect'
    }[packet.action_id]
    if (event) bot.emit(event, entity)
  })

  bot._client.on('update_attributes', packet => {
    const entity = entityForRuntime(packet.runtime_entity_id)
    if (!entity) return
    applyAttributes(entity, packet.attributes)
    bot.emit('entityAttributes', entity)
  })

  bot._client.on('mob_effect', packet => {
    const entity = entityForRuntime(packet.runtime_entity_id)
    if (!entity) return

    if (packet.event_id === 'remove') {
      const effect = entity.effects[packet.effect_id] || {
        id: packet.effect_id,
        amplifier: packet.amplifier,
        duration: packet.duration
      }
      delete entity.effects[packet.effect_id]
      bot.emit('entityEffectEnd', entity, effect)
      return
    }

    const effect = {
      id: packet.effect_id,
      amplifier: packet.amplifier,
      duration: packet.duration
    }
    entity.effects[effect.id] = effect
    bot.emit('entityEffect', entity, effect)
  })

  bot.on('spawn', () => {
    if (bot.entity) bot.emit('entitySpawn', bot.entity)
  })

  function addPlayerListRecord (record) {
    let player = bot._playerFromUUID(record.uuid) || bot.players[record.username]
    const isNew = !player
    if (!player) player = {}

    const previousUsername = player.username
    player.uuid = record.uuid
    player.username = record.username
    player.displayName = new ChatMessage({ text: '', extra: [{ text: record.username }] })
    player.ping ??= 0
    player.gamemode ??= 0
    player.entity ??= Object.values(bot.entities).find(entity => entity.type === 'player' && entity.uuid === record.uuid) || null
    player.xboxUserId = record.xbox_user_id
    player.buildPlatform = record.build_platform
    player.entityUniqueId = record.entity_unique_id

    if (previousUsername && previousUsername !== record.username) delete bot.players[previousUsername]
    bot.players[record.username] = player
    bot.uuidToUsername[record.uuid] = record.username
    if (player.entity === bot.entity || record.uuid === bot.entity?.uuid) bot.player = player

    bot.emit(isNew ? 'playerJoined' : 'playerUpdated', player)
  }

  function removePlayerListRecord (uuid) {
    const player = bot._playerFromUUID(uuid)
    if (!player || player.entity === bot.entity) return
    player.entity = null
    delete bot.players[player.username]
    delete bot.uuidToUsername[uuid]
    bot.emit('playerLeft', player)
  }

  function fetchEntity (runtimeId) {
    return bot.entities[runtimeId] || (bot.entities[runtimeId] = new Entity(runtimeId))
  }

  function entityForRuntime (runtimeId) {
    const id = runtimeNumber(runtimeId)
    return id == null ? null : bot.entities[id]
  }

  function removeEntity (runtimeId) {
    const entity = bot.entities[runtimeId]
    if (!entity || entity === bot.entity) return
    bot.emit('entityGone', entity)
    entity.isValid = false
    if (entity.username && bot.players[entity.username]) bot.players[entity.username].entity = null
    delete bot.entities[runtimeId]
  }

  function runtimeNumber (runtimeId) {
    const id = Number(runtimeId)
    if (!Number.isSafeInteger(id)) {
      bot._warn(`Ignoring Bedrock entity runtime ID outside JavaScript's safe integer range: ${runtimeId}`)
      return null
    }
    return id
  }

  function coordinates (packet, prefix) {
    const x = packet[`${prefix}x`]
    const y = packet[`${prefix}y`]
    const z = packet[`${prefix}z`]
    return x == null || y == null || z == null ? undefined : { x, y, z }
  }

  function setPlayerEntity (entity, username, uuid) {
    const data = bot.registry.entitiesArray?.find(entry => entry.name === 'player')
    entity.type = 'player'
    entity.name = 'player'
    entity.username = username
    entity.uuid = uuid
    applyEntityData(entity, data)
  }

  function setEntityData (entity, identifier) {
    const name = identifier.replace(/^minecraft:/, '')
    const data = bot.registry.entitiesArray?.find(entry => entry.name === name)
    entity.name = name
    applyEntityData(entity, data)
    if (!data) {
      entity.type = 'other'
      entity.displayName = identifier
      entity.kind = 'unknown'
    }
  }

  function applyEntityData (entity, data) {
    if (!data) return
    entity.type = data.type || 'object'
    entity.displayName = data.displayName
    entity.entityType = data.id
    entity.name = data.name
    entity.kind = data.category
    entity.height = data.height
    entity.width = data.width
  }

  function setTransform (entity, packet) {
    setPosition(entity, packet.position)
    setVelocity(entity, packet.velocity)
    entity.yaw = conv.fromNotchianYaw(packet.yaw)
    entity.pitch = conv.fromNotchianPitch(packet.pitch)
    entity.headYaw = conv.fromNotchianYaw(packet.head_yaw)
  }

  function setPosition (entity, position) {
    if (position) entity.position.set(position.x, position.y, position.z)
  }

  function setVelocity (entity, velocity) {
    if (velocity) entity.velocity.set(velocity.x, velocity.y, velocity.z)
  }

  function applyMetadata (entity, metadata = []) {
    for (const entry of metadata) entity.metadata[entry.key] = entry.value
  }

  function updateBreath (metadata = []) {
    const air = metadata.find(entry => entry.key === 'air' || entry.key === 7)
    if (!air) return
    bot.oxygenLevel = Math.round(air.value / 15)
    bot.emit('breath')
  }

  function applyAttributes (entity, attributes = []) {
    entity.attributes ??= {}
    for (const attribute of attributes) {
      entity.attributes[attribute.name] = {
        value: attribute.current ?? attribute.value,
        min: attribute.min,
        max: attribute.max,
        default: attribute.default
      }
    }
  }
}
