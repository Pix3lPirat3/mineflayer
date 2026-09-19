module.exports = inject

function inject (bot) {
  const clocks = new Map()
  const pendingStates = new Map()
  bot.time = {
    doDaylightCycle: null,
    bigTime: null,
    time: null,
    timeOfDay: null,
    day: null,
    isDay: null,
    moonPhase: null,
    bigAge: null,
    age: null,
    clocks: {}
  }

  bot._client.once('start_game', packet => {
    const tick = toBigInt(packet.current_tick)
    setTime(tick, tick, packet.day_cycle_stop_time !== undefined && packet.day_cycle_stop_time < 0)
  })

  bot._client.on('set_time', packet => {
    const time = toBigInt(packet.time)
    setTime(time, bot.time.bigAge ?? time, false)
  })

  bot._client.on('sync_world_clocks', packet => {
    if (packet.payload_type === 'initialize_registry') {
      for (const clock of packet.clocks || []) {
        const id = String(clock.id)
        const state = pendingStates.get(id)
        clocks.set(id, { ...clock, ...(state || {}) })
      }
    } else if (packet.payload_type === 'sync_state') {
      for (const state of packet.sync_states || []) {
        const id = String(state.clock_id)
        pendingStates.set(id, state)
        if (clocks.has(id)) Object.assign(clocks.get(id), state)
      }
    }
    updateFromClock(packet)
  })

  bot._client.on('game_rules_changed', packet => {
    const daylight = (packet.rules || []).find(rule => rule.name.toLowerCase() === 'dodaylightcycle')
    if (!daylight) return
    bot.time.doDaylightCycle = Boolean(daylight.value)
    bot.emit('time')
  })

  function updateFromClock (packet) {
    const dimension = bot.game?.dimension || 'overworld'
    const namedClock = [...clocks.values()].find(clock => clock.name === `minecraft:${dimension.replace('the_', '')}`)
    const packetState = packet.sync_states?.[0]
    const clock = namedClock || [...clocks.values()][0] || packetState
    if (!clock) return
    const time = toBigInt(clock.time)
    setTime(time, time, clock.paused)
  }

  function setTime (time, age, paused) {
    const finalTime = time < 0n ? -time : time
    bot.time.doDaylightCycle = !paused
    bot.time.bigTime = finalTime
    bot.time.time = Number(finalTime)
    bot.time.timeOfDay = bot.time.time % 24000
    bot.time.day = Math.floor(bot.time.time / 24000)
    bot.time.isDay = bot.time.timeOfDay >= 0 && bot.time.timeOfDay < 13000
    bot.time.moonPhase = bot.time.day % 8
    bot.time.bigAge = age
    bot.time.age = Number(age)
    bot.emit('time')
  }
}

function toBigInt (value) {
  if (typeof value === 'bigint') return value
  if (Array.isArray(value)) return BigInt.asIntN(64, (BigInt(value[0]) << 32n) | BigInt(value[1] >>> 0))
  return BigInt(Math.trunc(value || 0))
}
