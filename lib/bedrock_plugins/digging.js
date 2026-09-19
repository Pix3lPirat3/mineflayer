module.exports = inject

// Bedrock block breaking, matching what a real 1.26 client sends (verified against the relay capture in
// reviews/bedrock-in-mineflayer): breaking rides player_auth_input.block_action, not a standalone packet. The
// sequence is start_break, then continue_break every tick, then continue_break + predict_break on the final tick;
// abort_break cancels. client_input drains bot._queueBlockAction into each auth-input tick and sets the block_action
// input flag. The server is authoritative: it simulates the break from start_break and turns the block to air, which
// we wait for as confirmation.
function inject (bot) {
  let digging = null

  const toPos = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

  function digDurationMs (block) {
    if (bot.game && bot.game.gameMode === 'creative') return 0
    try {
      if (typeof block.digTime === 'function') {
        const held = bot.heldItem ? bot.heldItem.type : null
        const ms = block.digTime(held)
        if (Number.isFinite(ms) && ms >= 0) return ms
      }
    } catch (e) { /* fall through to default */ }
    return 1000
  }

  // vecPosition is a Vec3 (bot.blockAt / world.getBlock needs .floored()); the plain {x,y,z} above is only for packets.
  function waitBroken (vecPosition, timeoutMs) {
    const isAir = () => { const b = bot.blockAt(vecPosition); return !b || b.name === 'air' }
    return new Promise((resolve) => {
      if (isAir()) return resolve(true)
      const start = Date.now()
      const iv = setInterval(() => {
        if (isAir()) { clearInterval(iv); resolve(true) } else if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve(false) }
      }, 50)
      iv.unref?.()
    })
  }

  // dig(block, [face]) - face defaults to 1 (top). Resolves true when the server confirms the block became air.
  bot.dig = async (block, face = 1) => {
    if (!block || !block.position) throw new Error('dig: a block with a position is required')
    if (bot._bedrockWorldSupport && !bot._bedrockWorldSupport.supported) throw new Error('dig: world block data is unavailable')
    const position = toPos(block.position)
    // Enter the digging state before the async look so isDigging()/stopDigging() are correct immediately.
    digging = { block, position, face }
    bot.emit('diggingStarted', block)
    if (bot.lookAt) {
      try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5)); await new Promise(resolve => setTimeout(resolve, 150)) } catch (e) { /* look is best-effort */ }
    }
    if (!digging) return false // stopped during the look
    bot._queueBlockAction({ action: 'start_break', position, face })

    const duration = digDurationMs(block)
    const start = Date.now()
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (!digging) { clearInterval(iv); return resolve() }
        if (Date.now() - start >= duration) {
          bot._queueBlockAction({ action: 'continue_break', position, face }, { action: 'predict_break', position, face })
          clearInterval(iv)
          resolve()
        } else {
          bot._queueBlockAction({ action: 'continue_break', position, face })
        }
      }, 50)
      iv.unref?.()
    })

    const broken = await waitBroken(block.position, 2000)
    digging = null
    bot.emit(broken ? 'diggingCompleted' : 'diggingAborted', block)
    if (!broken) throw new Error('dig: the server did not break the block (timed out)')
    return broken
  }

  bot.stopDigging = () => {
    if (!digging) return
    bot._queueBlockAction({ action: 'abort_break', position: digging.position, face: digging.face })
    bot.emit('diggingAborted', digging.block)
    digging = null
  }

  bot.isDigging = () => digging !== null
}
