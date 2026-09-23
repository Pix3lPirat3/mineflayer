module.exports = inject

// Parity wrappers that give Bedrock the mineflayer-java entry-point names, built on the primitives the other bedrock
// plugins already provide (openContainer/openStation, useOn, moveInventoryItem, the trade window). Kept thin so behaviour
// stays consistent with the tested underlying methods.
function inject (bot) {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const QUICK_BAR_START = 36
  const bedrockOf = (javaSlot) => javaSlot >= QUICK_BAR_START ? javaSlot - QUICK_BAR_START : javaSlot

  const waitWindow = async (ms = 3000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) { if (bot.currentWindow) return bot.currentWindow; await wait(80) }
    return bot.currentWindow || null
  }

  // Open a container/station block and resolve with the window (mineflayer's openBlock/openChest/openContainer contract).
  bot.openBlock = async (block) => { if (typeof bot.openContainer !== 'function') throw new Error('openBlock needs the containers plugin'); bot.openContainer(block); return waitWindow() }
  if (!bot.openChest) bot.openChest = bot.openBlock
  const openStationBlock = async (block) => { if (typeof bot.openStation === 'function') return bot.openStation(block); bot.openContainer(block); return waitWindow() }
  bot.openFurnace = openStationBlock
  bot.openDispenser = openStationBlock
  // Anvil: return the open window with the Java-shaped window methods (mineflayer-java attaches anvil.combine/anvil.rename
  // to the window). Delegate to the verified bot.anvilCombine/bot.anvilRename with a null block (the anvil is already open,
  // so they skip re-opening). Without these a Java-written bot doing `const a = await bot.openAnvil(b); a.rename(i,'x')`
  // throws "a.rename is not a function".
  bot.openAnvil = async (block) => {
    const w = await openStationBlock(block)
    if (w && typeof bot.anvilRename === 'function' && !w.rename) {
      w.rename = (item, name) => bot.anvilRename(null, item, name)
      w.combine = (itemOne, itemTwo, name) => bot.anvilCombine(null, itemOne, itemTwo, name || '')
    }
    return w
  }
  // Enchant table: return the window with the Java-shaped accessors. The computed enchantments[]/xpseed/'ready' layer is
  // filled by the stations plugin from player_enchant_options; here we add the item accessors + a convenience enchant()
  // that delegates to the verified bot.enchant (which drives the full item_stack_request choreography).
  bot.openEnchantmentTable = async (block) => {
    const w = await openStationBlock(block)
    if (w && !w.targetItem) {
      w.targetItem = () => (w.slots || [])[0] || null
      w.lapisItem = () => (w.slots || [])[1] || null
      if (w.enchantments === undefined) w.enchantments = []
      // enchant(item, choice) or enchant(choice): item defaults to the current target slot / first inventory item.
      w.enchant = (a, b) => {
        const choice = typeof a === 'number' ? a : (b ?? 0)
        const item = (typeof a === 'number' || a == null) ? (w.targetItem() || bot.inventory.items()[0]) : a
        return bot.enchant(null, item, choice)
      }
    }
    return w
  }

  // Open an entity that has an inventory (chest/hopper minecart, ...) - Bedrock interacts with it like useOn.
  bot.openEntity = async (entity) => { if (typeof bot.useOn !== 'function') throw new Error('openEntity needs the interact plugin'); bot.useOn(entity); return waitWindow() }
  // Open a villager/wandering-trader and resolve with the parsed trade window.
  bot.openVillager = async (entity) => {
    const ready = new Promise((resolve) => { const to = setTimeout(() => resolve(bot.tradeWindow || null), 6000); bot.once('tradeListReady', (_t, w) => { clearTimeout(to); resolve(w) }) })
    bot.useOn(entity)
    return ready
  }
  // Interact with an entity (alias for useOn); the *At variant ignores the click position on Bedrock (server-validated).
  if (!bot.activateEntity) bot.activateEntity = (entity) => bot.useOn(entity)
  if (!bot.activateEntityAt) bot.activateEntityAt = (entity, _position) => bot.useOn(entity)

  // Move an item between two Java window slots. Player-inventory slots (>= 9) map onto the tested moveInventoryItem;
  // moving in/out of the open container's slots uses depositItem/withdrawItem. Java hotbar 36..44 -> Bedrock 0..8.
  bot.moveSlotItem = async (sourceSlot, destSlot) => {
    const invStart = bot.currentWindow ? (bot.currentWindow.inventoryStart ?? (bot.currentWindow.slots ? bot.currentWindow.slots.length : 9)) : 9
    const srcInInv = sourceSlot >= invStart || !bot.currentWindow
    const dstInInv = destSlot >= invStart || !bot.currentWindow
    if (srcInInv && dstInInv) { bot.moveInventoryItem(bedrockOf(sourceSlot - (bot.currentWindow ? invStart - 9 : 0)), bedrockOf(destSlot - (bot.currentWindow ? invStart - 9 : 0))); await wait(150); return }
    if (srcInInv && !dstInInv && typeof bot.depositItem === 'function') { bot.depositItem(bedrockOf(sourceSlot - (invStart - 9)), destSlot); await wait(150); return }
    if (!srcInInv && dstInInv && typeof bot.withdrawItem === 'function') { bot.withdrawItem(sourceSlot, bedrockOf(destSlot - (invStart - 9))); await wait(150); return }
    // container -> container: rearrange within the open container. Bedrock addresses both by container_id 'container' + the
    // 0-based slot (same as deposit/withdraw), so one item_stack_request 'place' moves the item across container slots.
    if (!srcInInv && !dstInInv && bot._stack) {
      const it = (bot.currentWindow.slots || [])[sourceSlot]
      await bot._stack.stackReq([{ type_id: 'place', legacy_type_id: 1, count: it ? it.count : 1, source: { slot_type: { container_id: 'container' }, slot: sourceSlot, stack_id: it ? (it.stackId ?? 0) : 0 }, destination: { slot_type: { container_id: 'container' }, slot: destSlot, stack_id: 0 } }])
      await wait(150); return
    }
    throw new Error('moveSlotItem: unsupported slot combination on Bedrock')
  }
  // Put the item at a window slot away into the player inventory (used by the Java station plugins after taking output).
  bot.putAway = async (slot) => {
    if (!bot.currentWindow) return
    const invStart = bot.currentWindow.inventoryStart ?? (bot.currentWindow.slots ? bot.currentWindow.slots.length : 9)
    if (slot < invStart && typeof bot.withdraw === 'function') {
      const it = (bot.currentWindow.slots || [])[slot]
      if (it) { try { await bot.withdraw(it.type, null, it.count) } catch {} }
    }
  }

  // Whether an item use (right-click hold) is currently active - mineflayer-java exposes usingHeldItem.
  Object.defineProperty(bot, 'usingHeldItem', { configurable: true, get () { return !!bot._usingItem } })

  // Deposit items of a type from the player inventory into the open container (mineflayer-java's putSelectedItemRange is
  // the low-level range mover; on Bedrock item moves are the tested bot.deposit, so delegate to it).
  bot.putSelectedItemRange = async (start, end, window, itemType) => {
    if (!bot.currentWindow || typeof bot.deposit !== 'function') return
    const item = bot.inventory.items().find(i => i.type === itemType || i.name === itemType)
    if (item) { try { await bot.deposit(item.type, null, item.count) } catch {} }
  }

  // clickWindow / simpleClick: mineflayer's Java click model over a window. Bedrock has no click packet - moves are
  // item_stack_request. We translate the common clicks: a left/right click on a slot with an empty cursor picks the item
  // up (tracked as bot.inventory.selectedItem), a click on another slot with a held cursor moves it there. This covers
  // the ecosystem's pick-up/place usage; complex shift/drag distributions fall back to moveSlotItem.
  bot.clickWindow = async (slot, mouseButton = 0, mode = 0) => {
    // mode 1 = shift-click (quick-move): send the slot's item to the other area (container <-> inventory), the common
    // "shift-click to deposit/withdraw the stack" that ecosystem code relies on.
    if (mode === 1) {
      const invStart = bot.currentWindow ? (bot.currentWindow.inventoryStart ?? (bot.currentWindow.slots ? bot.currentWindow.slots.length : 9)) : 9
      const it = ((bot.currentWindow && bot.currentWindow.slots) || bot.inventory.slots)[slot]
      if (!it) return
      if (slot < invStart && bot.currentWindow && typeof bot.withdraw === 'function') { try { await bot.withdraw(it.type, null, it.count) } catch {} return }
      if (typeof bot.deposit === 'function' && bot.currentWindow) { try { await bot.deposit(it.type, null, it.count) } catch {} }
      return
    }
    // mode 0 = the two-click cursor model: first click picks the slot up, the next click places it.
    if (bot._cursorSlot == null) { bot._cursorSlot = slot; bot._cursorFrom = slot; return }
    const from = bot._cursorFrom
    bot._cursorSlot = null; bot._cursorFrom = null
    if (from !== slot) return bot.moveSlotItem(from, slot)
  }
  bot.simpleClick = { leftMouse: (slot) => bot.clickWindow(slot, 0, 0), rightMouse: (slot) => bot.clickWindow(slot, 1, 0) }

  // Set a command block's command (Bedrock command_block_update). Position is a Vec3/block position.
  bot.setCommandBlock = (pos, command, options = {}) => {
    const send = (n, p) => { if (typeof bot._client.queue === 'function') bot._client.queue(n, p); else bot._client.write(n, p) }
    send('command_block_update', {
      is_block: true,
      position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
      mode: options.mode ?? 0,
      redstone_mode: options.alwaysActive ? 1 : 0,
      is_conditional: !!options.conditional,
      command: command || '',
      last_output: '',
      name: options.name || '',
      should_track_output: options.trackOutput ?? true,
      tick_delay: options.tickDelay ?? 0,
      execute_on_first_tick: options.executeOnFirstTick ?? true
    })
  }

  // Server transfer (Bedrock 'transfer' packet asks the client to move to another server). Renamed from bot.transfer to
  // avoid colliding with mineflayer-java's bot.transfer (an ITEM mover) - calling the Java contract here used to risk
  // bouncing the bot to another server. bot.transferServer is the Bedrock-only intent, spelled unambiguously.
  bot.transferServer = (options = {}) => {
    const send = (n, p) => { if (typeof bot._client.queue === 'function') bot._client.queue(n, p); else bot._client.write(n, p) }
    if (!options.host) throw new Error('transferServer: host required')
    send('transfer', { server_address: options.host, server_port: options.port ?? 19132 })
  }

  // Java-parity bot.transfer(options): move items between window slot ranges (index.d.ts TransferOptions). Moves matching
  // items from [sourceStart,sourceEnd) into free/stackable slots in [destStart,destEnd), up to `count` items. A full-stack
  // move uses bot.moveSlotItem; a PARTIAL move (need < the source stack) uses a count-limited item_stack_request 'place'
  // so the exact count is honoured (Java splits stacks the same way).
  bot.transfer = async (options = {}) => {
    const win = options.window || bot.currentWindow || bot.inventory
    const slots = (win && win.slots) || []
    const itemType = typeof options.itemType === 'string'
      ? (bot.registry.itemsByName[options.itemType] && bot.registry.itemsByName[options.itemType].id)
      : options.itemType
    const meta = options.metadata
    let need = options.count == null ? Infinity : options.count
    const sStart = options.sourceStart ?? 0
    const sEnd = options.sourceEnd ?? slots.length
    const dStart = options.destStart ?? 0
    const dEnd = options.destEnd ?? slots.length
    const findDest = () => {
      for (let d = dStart; d < dEnd; d++) if (!slots[d]) return d // prefer empty
      for (let d = dStart; d < dEnd; d++) { const it = slots[d]; if (it && it.type === itemType && it.count < (it.stackSize ?? 64)) return d }
      return null
    }
    // Move exactly `count` items from one player-inventory slot to another. Bedrock rejects a partial stack split unless
    // the inventory SCREEN is open (a raw closed-inventory split returns status 50), so open it around the move. The
    // count-limited move is bot.moveInventoryItem (authoritative stack ids + local relocation). Container moves stay whole.
    const movePartial = async (srcSlot, dstSlot, count) => {
      if (bot.currentWindow || typeof bot.moveInventoryItem !== 'function') return bot.moveSlotItem(srcSlot, dstSlot)
      const closeInv = (bot._stack && bot._stack.withInventoryOpen) ? await bot._stack.withInventoryOpen() : (() => {})
      bot.moveInventoryItem(bedrockOf(srcSlot), bedrockOf(dstSlot), count)
      await wait(400)
      try { closeInv() } catch {}
      await wait(150)
    }
    let moved = 0
    for (let s = sStart; s < sEnd && need > 0; s++) {
      const it = slots[s]
      if (!it || it.type !== itemType) continue
      if (meta != null && it.metadata !== meta) continue
      const dest = findDest()
      if (dest == null) break
      const take = Math.min(need, it.count)
      if (take >= it.count) await bot.moveSlotItem(s, dest)
      else await movePartial(s, dest, take)
      moved += take
      need -= take
    }
    return moved
  }

  // bot.elytraFly is implemented in the client_input plugin (it needs the player_auth_input flag stream); not stubbed here.

  // Genuinely Bedrock-different surfaces, stubbed so ecosystem code that reads them does not crash on a Bedrock bot
  // (see the parity gap map). Explosion damage is server-authoritative on Bedrock (knockback arrives as set_entity_motion),
  // so the Java client-side damage calc does not apply; teams and the tablist header/footer have no Bedrock equivalent
  // (scoreboard covers the rest, and bot.teamMap is kept as {} by scoreboard.js).
  if (!bot.getExplosionDamages) bot.getExplosionDamages = () => null
  bot.teams = bot.teams || {}
  // Seed the tablist header/footer as ChatMessage objects (not bare strings) so ecosystem code that calls
  // header.toString()/toAnsi()/toMotd() works. Bedrock has no header/footer packet, so they stay empty.
  if (!bot.tablist) {
    const ChatMessage = require('prismarine-chat')(bot.registry)
    bot.tablist = { header: new ChatMessage(''), footer: new ChatMessage('') }
  }
}
