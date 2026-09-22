'use strict'
// Block-break progress caused by OTHER entities, mirroring mineflayer-java's block_actions plugin. On Bedrock this arrives
// as level_event block-break events (3600 block_start_break, 3602 block_break_speed, 3601 block_stop_break), which are
// POSITION-based - the wire carries no entity id, so the observed-entity argument is null (a documented Bedrock limitation;
// the Java event passes the breaking entity). Stage is a best-effort 0..9 from the accumulated break speed.
const { Vec3 } = require('vec3')

module.exports = function inject (bot) {
  const progress = new Map() // "x,y,z" -> accumulated stage 0..9
  const keyOf = (p) => `${p.x},${p.y},${p.z}`
  const blockAt = (p) => { try { return bot.blockAt(new Vec3(p.x, p.y, p.z)) } catch { return null } }

  bot._client.on('level_event', packet => {
    const p = packet.position
    if (!p) return
    switch (packet.event) {
      case 'block_start_break': {
        const block = blockAt(p); if (!block) return
        progress.set(keyOf(p), 0)
        bot.emit('blockBreakProgressObserved', block, 0, null)
        break
      }
      case 'block_break_speed': {
        const block = blockAt(p); if (!block) return
        // data is the per-tick break increment (65536/totalTicks); accumulate toward a 0..9 destroy stage.
        const k = keyOf(p)
        const acc = Math.min(9, (progress.get(k) ?? 0) + Math.max(1, Math.round((packet.data || 0) / 65536 * 9)))
        progress.set(k, acc)
        bot.emit('blockBreakProgressObserved', block, acc, null)
        break
      }
      case 'block_stop_break': {
        progress.delete(keyOf(p))
        const block = blockAt(p)
        if (block) bot.emit('blockBreakProgressEnd', block, null)
        break
      }
    }
  })

  // block_event is Bedrock's equivalent of Java's block_action: a chest lid opening/closing, a piston moving, or a note
  // block playing. All arrive with type 'change_state' and carry the new state in `data`, so route by the BLOCK at the
  // position, not the type (a note block sends change_state with data = its note/pitch, verified live).
  const INSTRUMENT = { stone: 'basedrum', sand: 'snare', red_sand: 'snare', gravel: 'snare', glass: 'hat', hardened_glass: 'hat', log: 'bass', log2: 'bass', planks: 'bass', wood: 'bass' }
  bot._client.on('block_event', packet => {
    const p = packet.position; if (!p) return
    const block = blockAt(p); if (!block) return
    const name = block.name || ''
    if (/chest|barrel|shulker|ender_chest/.test(name)) bot.emit('chestLidMove', block, packet.data, null) // data = viewers/open state
    else if (/piston/.test(name)) bot.emit('pistonMove', block, packet.data, 0) // NOTE: Bedrock does not broadcast piston moves as block_event (unlike Java's block_action) - piston state arrives as block updates instead, so this rarely fires; kept for any server that does send it
    else if (/note/.test(name)) { // data = the note (pitch 0..24); the instrument is set by the block below
      const below = blockAt(new Vec3(p.x, p.y - 1, p.z))
      bot.emit('noteHeard', block, (below && INSTRUMENT[below.name]) || 'harp', packet.data)
    }
  })

  // The player-facing sign edit UI open (server tells the client to open a sign it just placed/clicked).
  bot._client.on('open_sign', packet => {
    if (!packet.position) return
    const block = blockAt(packet.position)
    if (block) bot.emit('signOpen', block, packet.is_front !== false)
  })
}
