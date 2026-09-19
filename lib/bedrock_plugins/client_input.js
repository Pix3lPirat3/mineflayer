const conv = require('../conversions')

module.exports = inject

function inject (bot) {
  let tick = 0n
  let timer
  let spawned = false
  let movementAuthority = 'server'

  bot._client.once('start_game', packet => {
    movementAuthority = packet.movement_authority ?? 'server'
  })
  bot._client.on('set_movement_authority', packet => {
    movementAuthority = packet.movement_authority
    if (movementAuthority === 'client') stop()
    else if (spawned) start()
  })
  bot.on('spawn', () => {
    spawned = true
    if (movementAuthority !== 'client') start()
  })
  bot._client.once('close', stop)

  function start () {
    if (timer) return
    send()
    timer = setInterval(send, 50)
    timer.unref?.()
  }

  function stop () {
    clearInterval(timer)
    timer = undefined
  }

  // 1.26.40 to 1.26.45 wrap the optional fields in an outer presence bool that the vanilla client always sends as
  // true; 1.26.50 dropped it. Read the schema instead of hardcoding the version range.
  const inputFields = (bot.registry.protocol?.types?.packet_player_auth_input?.[1] || []).map(f => f && f.name).filter(n => typeof n === 'string')
  const presenceFlags = Object.fromEntries(inputFields.filter(n => n.endsWith('_presence')).map(n => [n, true]))
  const modern = bot.registry.version['>=']('1.26.40')

  // Block breaking on 1.26 rides the auth input, not a standalone packet: the real client puts start_break /
  // continue_break / predict_break / abort_break entries in block_action and sets the matching input_data flag (see
  // reviews capture). Other plugins (digging) enqueue actions here; send() drains them into the next tick.
  const pendingBlockActions = []
  bot._queueBlockAction = (...entries) => { for (const e of entries) if (e) pendingBlockActions.push(e) }

  // Movement. Bedrock 1.26 is server-authoritative: the client reports its input each tick (a local-frame move_vector
  // plus input-flag presses) and the server simulates and returns the authoritative position in correct_player_move_
  // prediction, which we apply. So setControlState only records intent; send() turns it into the move_vector/flags and
  // the server drives the actual motion. Verified live: forward input walks the bot and the corrections track it.
  bot.controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  bot.setControlState = (control, state) => {
    if (!(control in bot.controlState)) throw new Error(`unknown control state: ${control}`)
    bot.controlState[control] = !!state
  }
  bot.getControlState = (control) => {
    if (!(control in bot.controlState)) throw new Error(`unknown control state: ${control}`)
    return bot.controlState[control]
  }
  bot.clearControlStates = () => { for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false }

  bot._client.on('correct_player_move_prediction', (packet) => {
    const pos = packet.position
    if (!pos || !bot.entity) return
    bot.entity.position.x = pos.x
    bot.entity.position.y = pos.y - (bot.entity.eyeHeight || 1.62)
    bot.entity.position.z = pos.z
    if (packet.velocity) bot.entity.velocity = packet.velocity
    bot.emit('move', bot.entity.position)
  })

  // Local-frame move vector and the matching input flags for the current controls (Bedrock: +z forward, +x left).
  function movementInput () {
    const cs = bot.controlState
    let x = 0; let z = 0; const flags = []
    if (cs.forward) { z += 1; flags.push('up') }
    if (cs.back) { z -= 1; flags.push('down') }
    if (cs.left) { x += 1; flags.push('left') }
    if (cs.right) { x -= 1; flags.push('right') }
    if (cs.jump) { flags.push('jumping'); flags.push('want_up') }
    if (cs.sneak) { flags.push('sneaking'); flags.push('sneak_down') }
    if (cs.sprint) flags.push('sprinting')
    return { vector: { x, z }, flags }
  }

  function send () {
    if (!bot.entity) return
    const pitch = conv.toNotchianPitch(bot.entity.pitch || 0)
    const yaw = conv.toNotchianYaw(bot.entity.yaw || 0)
    const cosPitch = Math.cos(bot.entity.pitch || 0)
    const blockActions = pendingBlockActions.splice(0)
    const move = movementInput()
    const flags = modern ? ['block_breaking_delay_enabled'] : { block_breaking_delay_enabled: true }
    if (blockActions.length) {
      if (Array.isArray(flags)) flags.push('block_action')
      else flags.block_action = true
    }
    for (const f of move.flags) {
      if (Array.isArray(flags)) flags.push(f)
      else flags[f] = true
    }
    const packet = {
      pitch,
      yaw,
      position: {
        x: bot.entity.position.x,
        y: bot.entity.position.y + (bot.entity.eyeHeight || 1.62),
        z: bot.entity.position.z
      },
      move_vector: move.vector,
      head_yaw: yaw,
      input_data: flags,
      input_mode: 'mouse',
      play_mode: 'screen',
      interaction_model: 'touch',
      interact_rotation: { x: pitch, z: yaw },
      tick: tick++,
      delta: { x: 0, y: 0, z: 0 },
      ...presenceFlags,
      analogue_move_vector: move.vector,
      camera_orientation: {
        x: -Math.sin(bot.entity.yaw || 0) * cosPitch,
        y: Math.sin(bot.entity.pitch || 0),
        z: -Math.cos(bot.entity.yaw || 0) * cosPitch
      },
      raw_move_vector: move.vector
    }
    if (blockActions.length) packet.block_action = blockActions
    bot._client.queue('player_auth_input', packet)
  }
}
