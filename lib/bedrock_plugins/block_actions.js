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
}
