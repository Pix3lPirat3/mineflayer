module.exports = inject

// Player abilities and adventure settings. update_abilities carries layered ability sets (the base layer holds the
// live flags: may-fly, flying, build, mine, ...) plus the permission level and movement speeds; update_adventure_
// settings carries the world-interaction toggles. Both are inbound only, so this just exposes state and fires events.
function inject (bot) {
  bot.abilities = null
  bot.adventureSettings = null

  bot._client.on('update_abilities', (packet) => {
    const layers = packet.abilities || []
    const base = layers.find(l => l.type === 'base') || layers[0] || {}
    bot.abilities = {
      permissionLevel: packet.permission_level,
      commandPermission: packet.command_permission,
      flags: base.enabled || {},
      allowed: base.allowed || {},
      flySpeed: base.fly_speed,
      verticalFlySpeed: base.vertical_fly_speed,
      walkSpeed: base.walk_speed,
      layers
    }
    bot.emit('abilitiesUpdate', bot.abilities)
  })

  bot._client.on('update_adventure_settings', (packet) => {
    bot.adventureSettings = {
      noPvm: packet.no_pvm,
      noMvp: packet.no_mvp,
      immutableWorld: packet.immutable_world,
      showNameTags: packet.show_name_tags,
      autoJump: packet.auto_jump
    }
    bot.emit('adventureSettingsUpdate', bot.adventureSettings)
  })
}
