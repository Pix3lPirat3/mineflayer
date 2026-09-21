module.exports = inject

// Fishing on Bedrock. Cast with the equipped fishing rod (activateItem -> item_use click_air spawns the fishing_hook),
// wait for the bite, then reel in (activateItem again). Bedrock signals the bite with an entity_event 'fish_hook_hook'
// (the same event that plays the splash); 'fish_hook_bubble'/'fish_hook_tease' are the approach cues before it. This
// mirrors the Java plugin's bot.fish() surface (a promise that resolves once the catch is reeled in). The caught item,
// if any, arrives right after as a normal item pickup (playerCollect). Verified live on BDS 1.26.45.
function inject (bot) {
  let fishing = null

  bot.fish = async () => {
    if (typeof bot.activateItem !== 'function') throw new Error('fish needs the interact plugin')
    const held = bot.heldItem
    if (!held || !/fishing_rod/.test(held.name || '')) throw new Error('fish: a fishing_rod must be equipped in the hand')
    if (fishing) throw new Error('fish: already fishing')

    bot.activateItem() // cast the line
    bot.emit('fishingCast')

    const caught = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('fish: timed out waiting for a bite')) }, 60000)
      const onEvent = (packet) => {
        if (packet.event_id === 'fish_hook_hook') {
          cleanup()
          bot.activateItem() // reel in
          bot.emit('fishingBite')
          // The catch (if any) is delivered as a normal pickup right after; surface it best-effort.
          const onCollect = (collector, collected) => { if (collector === bot.entity) { bot.removeListener('playerCollect', onCollect); resolve(collected) } }
          bot.on('playerCollect', onCollect)
          setTimeout(() => { bot.removeListener('playerCollect', onCollect); resolve(null) }, 1500)
        }
      }
      function cleanup () { clearTimeout(timeout); bot._client.removeListener('entity_event', onEvent); fishing = null }
      fishing = { cancel: (err) => { cleanup(); reject(err) } }
      bot._client.on('entity_event', onEvent)
    })
    return caught
  }
}
