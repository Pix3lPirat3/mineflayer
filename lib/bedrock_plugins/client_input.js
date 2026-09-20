const conv = require('../conversions')
const Vec3 = require('vec3')
const { Physics, PlayerState } = require('prismarine-physics')

module.exports = inject

function inject (bot) {
  // World view the physics engine queries for collision (loaded chunks only; unloaded reads null and the server reconciles).
  const world = { getBlock: (pos) => (typeof bot.blockAt === 'function' ? bot.blockAt(pos) : null) }
  let timer
  let spawned = false
  let movementAuthority = 'server'

  // Bedrock server-authoritative movement uses a rewind buffer (start_game.rewind_history_size, e.g. 40 ticks) and
  // correlates each player_auth_input to a server tick. An input whose tick is outside that window is dropped, so the
  // player never moves. Two things make a simple `tick++` per send drift out of the window: the server's tick is not
  // zero at join (start_game.current_tick), and our send timer does not fire at exactly 20 Hz (event-loop jitter drops
  // it to ~16 Hz under load), so counting sends falls behind the server's real tick by tens of ticks within seconds.
  // Instead we anchor to a known (serverTick, wall-clock) pair and derive each input's tick from elapsed real time, and
  // re-anchor from correct_player_move_prediction.tick (the server's authoritative tick), which keeps us in the window.
  const toTick = (v) => {
    if (v == null) return 0n
    if (typeof v === 'bigint') return v
    if (typeof v === 'number') return BigInt(Math.floor(v))
    if (Array.isArray(v)) return (BigInt(v[0] >>> 0) << 32n) | BigInt(v[1] >>> 0) // [high, low]
    try { return BigInt(v) } catch { return 0n }
  }
  let anchorTick = 0n
  let anchorTime = Date.now()
  let lastEmittedTick = null
  const currentTick = () => anchorTick + BigInt(Math.max(0, Math.round((Date.now() - anchorTime) / 50)))
  bot._client.once('start_game', packet => {
    movementAuthority = packet.movement_authority ?? 'server'
    if (packet.current_tick != null) { anchorTick = toTick(packet.current_tick); anchorTime = Date.now() }
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
    state = !!state
    const wasPressed = bot.controlState[control]
    bot.controlState[control] = state
    // Jump is an impulse the physics engine consumes via jumpQueued (as mineflayer's Java controlState setter does).
    if (control === 'jump' && state && !wasPressed) bot.jumpQueued = true
  }
  bot.getControlState = (control) => {
    if (!(control in bot.controlState)) throw new Error(`unknown control state: ${control}`)
    return bot.controlState[control]
  }
  bot.clearControlStates = () => { for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false }

  // Look control (mirrors the Java physics plugin). Bedrock transmits yaw/pitch on every player_auth_input tick, so
  // setting the entity look is enough; we keep vanilla's sensitivity rounding for anticheat parity. bot.lookAt/look are
  // what pathfinder and the interaction plugins call to aim before moving/placing/digging.
  bot.look = async (yaw, pitch, force) => {
    const sensitivity = conv.fromNotchianPitch(0.15) // 100% vanilla sensitivity
    const yawChange = Math.round((yaw - (bot.entity.yaw || 0)) / sensitivity) * sensitivity
    const pitchChange = Math.round((pitch - (bot.entity.pitch || 0)) / sensitivity) * sensitivity
    if (yawChange === 0 && pitchChange === 0) return
    bot.entity.yaw = (bot.entity.yaw || 0) + yawChange
    bot.entity.pitch = (bot.entity.pitch || 0) + pitchChange
  }
  bot.lookAt = async (point, force) => {
    const p = (point && typeof point.minus === 'function') ? point : new Vec3(point.x, point.y, point.z)
    const delta = p.minus(bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0))
    const yaw = Math.atan2(-delta.x, -delta.z)
    const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
    const pitch = Math.atan2(delta.y, groundDistance)
    await bot.look(yaw, pitch, force)
  }

  // Physics. Bedrock movement is server-authoritative, but BDS accepts a client that self-simulates and reports its
  // position (verified: near-vanilla walk/sprint on open ground with zero corrections). So we run the shared
  // prismarine-physics engine each tick - the same collision, step-up, gravity and jump that Java uses, now edition-aware
  // for Bedrock - and report the result over player_auth_input; correct_player_move_prediction is the authoritative
  // correction. Running the shared engine also gives bot.physics, bot.entity.onGround and a physicsTick, which is what
  // mineflayer-pathfinder consumes, so pathfinder works on Bedrock without a bespoke movement model.
  bot.physics = Physics(bot.registry, world)
  if (bot.physicsEnabled === undefined) bot.physicsEnabled = true
  bot.jumpTicks = bot.jumpTicks || 0
  bot.jumpQueued = false
  bot.fireworkRocketDuration = bot.fireworkRocketDuration || 0

  // prismarine-physics reads these entity fields; the Bedrock entity may not carry them yet, so default them in place.
  function ensurePhysicsEntity () {
    const e = bot.entity
    if (!e) return false
    if (!e.velocity) e.velocity = new Vec3(0, 0, 0)
    if (e.onGround === undefined) e.onGround = false
    if (!e.effects) e.effects = {}
    if (!e.attributes) e.attributes = {}
    for (const f of ['isInWater', 'isInLava', 'isInWeb', 'isCollidedHorizontally', 'isCollidedVertically', 'elytraFlying']) {
      if (e[f] === undefined) e[f] = false
    }
    if (!bot.inventory || !bot.inventory.slots) return false // PlayerState reads inventory slots; wait until it exists
    return true
  }

  bot._client.on('correct_player_move_prediction', (packet) => {
    // Re-anchor our tick to the server's authoritative tick so send-rate jitter never drifts us out of the rewind window.
    if (packet.tick != null) { anchorTick = toTick(packet.tick); anchorTime = Date.now() }
    const pos = packet.position
    if (!pos || !bot.entity) return
    // The engine predicts collision, so on valid terrain we track the server and it rarely corrects. When it does (real
    // divergence: knockback, a mis-predicted edge), take the server position and Y authoritatively and reset velocity.
    const feetY = pos.y - (bot.entity.eyeHeight || 1.62)
    const drift = Math.hypot(pos.x - bot.entity.position.x, pos.z - bot.entity.position.z)
    bot.entity.position.y = feetY
    if (drift > 0.5) {
      bot.entity.position.x = pos.x
      bot.entity.position.z = pos.z
      if (bot.entity.velocity) { bot.entity.velocity.x = 0; bot.entity.velocity.z = 0 }
    }
    if (packet.velocity) bot.entity.velocity = new Vec3(packet.velocity.x || 0, packet.velocity.y || 0, packet.velocity.z || 0)
    bot.emit('move', bot.entity.position)
  })

  // Local-frame move vector and the matching input flags for the current controls (Bedrock: +z forward, +x left).
  // Server-authoritative movement needs the edge/action flags (start_sprinting / start_sneaking / start_jumping and
  // their stop_* counterparts) to change the player's movement state, plus the sustained state flags (sprinting,
  // sneaking, sprint_down). Sending only the sustained flags leaves the server never entering the sprint/walk state,
  // so it holds the player in place. We latch the previous controls and emit the matching start_/stop_ flag on each edge.
  const prev = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  function movementInput () {
    const cs = bot.controlState
    let x = 0; let z = 0; const flags = []
    if (cs.forward) { z += 1; flags.push('up') }
    if (cs.back) { z -= 1; flags.push('down') }
    if (cs.left) { x += 1; flags.push('left') }
    if (cs.right) { x -= 1; flags.push('right') }
    if (cs.jump) { flags.push('jumping'); flags.push('want_up') }
    if (cs.jump && !prev.jump) flags.push('start_jumping')
    if (cs.sneak) { flags.push('sneaking'); flags.push('sneak_down') }
    if (cs.sneak && !prev.sneak) flags.push('start_sneaking')
    if (!cs.sneak && prev.sneak) flags.push('stop_sneaking')
    if (cs.sprint) { flags.push('sprinting'); flags.push('sprint_down') }
    if (cs.sprint && !prev.sprint) flags.push('start_sprinting')
    if (!cs.sprint && prev.sprint) flags.push('stop_sprinting')
    for (const k of Object.keys(prev)) prev[k] = cs[k]
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
    // Advance the shared physics engine once per elapsed server tick (keeps 20 Hz motion despite the ~16 Hz timer), then
    // report the resulting position and per-tick delta. Gravity, jump, step-up and collision all come from the engine;
    // move_vector/flags below still carry the raw intent the server also reads.
    const target = currentTick()
    // Advance exactly one physics step per elapsed server tick. The send timer runs faster than 20 Hz, so many sends
    // fall inside the same tick and must step 0 (not a forced 1) - forcing a step over-predicts, which reads as ~19%
    // fast on walk and, for the faster sprint, over-shoots the server's tolerance so its correction snaps the bot back.
    let steps = lastEmittedTick == null ? 1 : Number(target - lastEmittedTick)
    if (steps < 0) steps = 0
    if (steps > 8) steps = 8
    if (bot.physicsEnabled !== false && ensurePhysicsEntity()) {
      for (let i = 0; i < steps; i++) {
        bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), world).apply(bot)
        bot.emit('physicsTick')
        bot.emit('physicTick') // deprecated alias, matches the Java plugin; ecosystem plugins (e.g. mineflayer-pvp) use it
      }
    }
    lastEmittedTick = target
    const vel = bot.entity.velocity || { x: 0, y: 0, z: 0 }
    // Mirror the real client's collision flags from the engine's state.
    if (Array.isArray(flags)) {
      if (bot.entity.onGround) flags.push('vertical_collision')
      if (bot.entity.isCollidedHorizontally) flags.push('horizontal_collision')
    } else {
      if (bot.entity.onGround) flags.vertical_collision = true
      if (bot.entity.isCollidedHorizontally) flags.horizontal_collision = true
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
      tick: target,
      delta: { x: vel.x, y: vel.y, z: vel.z },
      ...presenceFlags,
      analogue_move_vector: { x: 0, z: 0 },
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
