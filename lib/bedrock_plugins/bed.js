const { Vec3 } = require('vec3')

module.exports = inject

// Sleeping in a bed on Bedrock. Interacting with a bed (activateBlock -> click_block) makes the server put the player
// in it; the server sets the player's player_bed_position metadata, which the entities plugin turns into
// entitySleep/entityWake for bot.entity (mirroring the Java bed plugin's events). Waking is a player_action
// 'stop_sleeping' (not the Java entity_action). The heavy Java stateId/facing geometry of the shared bed plugin is
// intentionally omitted - the Bedrock server is authoritative about whether a bed can be slept in. Verified live on
// BDS 1.26.45: sleep sets player_bed_position + fires 'sleep'; wake clears it + fires 'wake'.
const BEDS = new Set(['white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed', 'lime_bed', 'pink_bed',
  'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed', 'bed'])

function inject (bot) {
  bot.isSleeping = false
  const send = (name, params) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, params); else bot._client.write(name, params) }
  const toBig = (v) => typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)))
  const selfRuntimeId = () => bot._client.entityId ?? (bot.entity && bot.entity.id)

  bot.isABed = (block) => !!block && BEDS.has(block.name)

  // Java parity: bot.parseBedMetadata(bedBlock) -> { part, occupied, facing, headOffset }. Bedrock beds carry their state
  // as block-state properties (direction 0-3, head_piece_bit, occupied_bit) rather than Java's packed metadata bits, so
  // read them from getProperties(). facing follows Java's convention (0 south, 1 west, 2 north, 3 east); headOffset is the
  // foot->head offset. Ecosystem auto-sleep code that calls parseBedMetadata used to throw on bedrock (method missing).
  const HEAD_OFFSET = { 0: [0, 0, 1], 1: [-1, 0, 0], 2: [0, 0, -1], 3: [1, 0, 0] }
  bot.parseBedMetadata = (bedBlock) => {
    const props = (bedBlock && typeof bedBlock.getProperties === 'function' ? bedBlock.getProperties() : {}) || {}
    const facing = Number(props.direction ?? 0) & 3
    const part = props.head_piece_bit === true || props.head_piece_bit === 1
    const occupied = (props.occupied_bit === true || props.occupied_bit === 1) ? 1 : 0
    const [ox, oy, oz] = HEAD_OFFSET[facing] || [0, 0, 1]
    return { part, occupied, facing, headOffset: new Vec3(ox, oy, oz) }
  }

  // The entities plugin emits entitySleep/entityWake from the player_flags SLEEPING-bit transition. Guard on the
  // current state so a repeated metadata broadcast can't fire a duplicate 'sleep'/'wake'.
  bot.on('entitySleep', (entity) => { if (entity === bot.entity && !bot.isSleeping) { bot.isSleeping = true; bot.emit('sleep') } })
  bot.on('entityWake', (entity) => { if (entity === bot.entity && bot.isSleeping) { bot.isSleeping = false; bot.emit('wake') } })

  // Sleep in the given bed block. Resolves once the server confirms (the 'sleep' event); rejects if it doesn't take
  // (e.g. not night, monsters nearby, obstructed) within the timeout. Bedrock validates all that server-side.
  bot.sleep = async (bedBlock) => {
    if (bot.isSleeping) throw new Error('already sleeping')
    if (!bot.isABed(bedBlock)) throw new Error('wrong block : not a bed block')
    if (typeof bot.activateBlock !== 'function') throw new Error('sleep needs the interact plugin')
    const slept = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { bot.removeListener('sleep', onSleep); reject(new Error('bot did not sleep (not night, monsters nearby, or bed obstructed?)')) }, 3000)
      function onSleep () { clearTimeout(timer); resolve() }
      bot.once('sleep', onSleep)
    })
    await bot.activateBlock(bedBlock)
    await slept
  }

  // Wake up. Bedrock leaves the bed with a player_action 'stop_sleeping' at the bed position.
  bot.wake = async () => {
    if (!bot.isSleeping) throw new Error('already awake')
    const bed = bot.entity.metadata?.player_bed_position || { x: 0, y: 0, z: 0 }
    const woke = new Promise((resolve) => {
      const timer = setTimeout(() => { bot.removeListener('wake', onWake); resolve() }, 2000)
      function onWake () { clearTimeout(timer); resolve() }
      bot.once('wake', onWake)
    })
    send('player_action', {
      runtime_entity_id: toBig(selfRuntimeId()),
      action: 'stop_sleeping',
      position: { x: bed.x | 0, y: bed.y | 0, z: bed.z | 0 },
      result_position: { x: 0, y: 0, z: 0 },
      face: 0
    })
    await woke
  }
}
