module.exports = inject

// Placing an entity from a held item (boat, minecart, armor stand, spawn egg, ...). On Bedrock this is an item_use on a
// block/water with the entity item held - the same click_block path as block placement, but the server spawns an ENTITY
// instead of setting a block, so we confirm by waiting for the entitySpawn near the target rather than a blockUpdate.
// Mirrors mineflayer-java's bot.placeEntity(referenceBlock, faceVector).
function inject (bot) {
  bot.placeEntity = async (referenceBlock, faceVector, options = {}) => {
    if (typeof bot._genericPlace !== 'function') throw new Error('placeEntity needs the interact plugin')
    if (!referenceBlock || !referenceBlock.position) throw new Error('placeEntity: a reference block is required')
    const fv = faceVector || { x: 0, y: 1, z: 0 }
    const target = referenceBlock.position.offset(fv.x, fv.y, fv.z).offset(0.5, 0.5, 0.5)
    const timeoutMs = options.timeout ?? 3000

    const spawned = new Promise((resolve) => {
      const timer = setTimeout(() => { bot.removeListener('entitySpawn', onSpawn); resolve(null) }, timeoutMs)
      function onSpawn (entity) {
        if (!entity || entity === bot.entity || !entity.position) return
        // A newly-spawned object entity within ~3 blocks of the placement cell is the one we placed.
        if (entity.position.distanceTo(target) <= 3) { clearTimeout(timer); bot.removeListener('entitySpawn', onSpawn); resolve(entity) }
      }
      bot.on('entitySpawn', onSpawn)
    })
    // Reuse the block-placement click (no blockUpdate confirmation - an entity spawns instead of a block change).
    await bot._genericPlace(referenceBlock, fv, { swingArm: options.swingArm || 'right', itemUseLifecycle: options.itemUseLifecycle })
    const entity = await spawned
    if (!entity) throw new Error('placeEntity: no entity spawned (is the item an entity item, and the spot valid?)')
    return entity
  }
}
