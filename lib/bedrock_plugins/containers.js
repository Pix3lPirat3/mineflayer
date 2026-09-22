module.exports = inject

// Bedrock containers (chests, furnaces, ...). The server opens a container with container_open, streams its items with
// inventory_content for that window id, reports progress fields with container_set_data, and ends it with
// container_close. Opening one is a click_block on the container (bot.openContainer -> the interact plugin's
// activateBlock); the server then drives the rest. Packet shapes verified against a relay capture.
//
// For a CHEST (window_type 'container') bot.currentWindow is a real prismarine-windows Window (created once the slot count
// is known from the first inventory_content), populated from BOTH the bedrock container slots AND the player inventory -
// so ecosystem code that expects a Window (window.containerItems()/items()/findContainerItem()/updateSlot events, etc.)
// works. This closes the read-side of PrismarineJS/prismarine-windows#140 with no change to that library: createWindow
// already builds a container window when given a slotCount, and we map the two bedrock inventories into its slot ranges.
// Station windows (furnace/anvil/enchant/...) keep the lightweight plain-object model the station plugins read.
function inject (bot) {
  const send = (name, packet) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, packet); else bot._client.write(name, packet) }
  const windowsLoader = require('prismarine-windows')(bot.registry)
  const decode = (it) => (bot._bedrockItemFromNotch ? bot._bedrockItemFromNotch(it) : it) || null
  const QUICK_BAR_START = 36
  const isChestType = (t) => t === 'container' || t === 'minecraft:container'

  // Copy the player inventory (bot.inventory is a minecraft:inventory Window: 9-35 main, 36-44 hotbar) into a chest
  // window's player section (slots inventoryStart..inventoryStart+35 = 27 main then 9 hotbar). Items are cloned so the
  // window setting item.slot cannot corrupt bot.inventory's own slot indices.
  const cloneAt = (it, slot) => { if (!it) return null; const c = it.clone ? it.clone() : Object.assign(Object.create(Object.getPrototypeOf(it)), it); c.slot = slot; return c }
  const syncPlayerIntoWindow = (win) => {
    const N = win.inventoryStart
    for (let i = 0; i < 27; i++) win.slots[N + i] = cloneAt(bot.inventory.slots[9 + i], N + i)
    for (let h = 0; h < 9; h++) win.slots[N + 27 + h] = cloneAt(bot.inventory.slots[QUICK_BAR_START + h], N + 27 + h)
  }
  // Mirror a single bot.inventory change into the open chest window's player section (keeps the Window live while open).
  const playerSlotToWindowSlot = (win, javaSlot) => {
    const N = win.inventoryStart
    if (javaSlot >= 9 && javaSlot <= 35) return N + (javaSlot - 9)
    if (javaSlot >= QUICK_BAR_START && javaSlot <= QUICK_BAR_START + 8) return N + 27 + (javaSlot - QUICK_BAR_START)
    return null
  }
  let invMirror = null
  const attachInvMirror = (win) => {
    detachInvMirror()
    invMirror = (slot, oldItem, newItem) => { const ws = playerSlotToWindowSlot(win, slot); if (ws != null) win.slots[ws] = newItem ? cloneAt(newItem, ws) : null }
    if (bot.inventory && typeof bot.inventory.on === 'function') bot.inventory.on('updateSlot', invMirror)
  }
  const detachInvMirror = () => { if (invMirror && bot.inventory && typeof bot.inventory.removeListener === 'function') bot.inventory.removeListener('updateSlot', invMirror); invMirror = null }

  let pendingChest = null
  // Station/plain windows (furnace/anvil/enchant/...) are lightweight objects, but they are EventEmitters so a window can
  // signal progress the mineflayer-java way (e.g. a furnace emits 'update' as its fuel/progress fields change).
  const { EventEmitter } = require('events')
  const plainWindow = (packet) => Object.assign(new EventEmitter(), {
    id: packet.window_id,
    type: packet.window_type,
    bedrockType: packet.window_type,
    position: packet.coordinates ? { x: packet.coordinates.x, y: packet.coordinates.y, z: packet.coordinates.z } : null,
    entityId: packet.runtime_entity_id,
    slots: [],
    properties: {},
    // Read accessors so station/plain windows expose the same shape as the chest Window's methods.
    containerItems () { return (this.slots || []).filter(Boolean) },
    items () { return [...(this.slots || []).filter(Boolean), ...(bot.inventory ? bot.inventory.items() : [])] },
    // prismarine-windows Window.updateSlot parity: set the slot AND emit updateSlot/updateSlot:<i> (with old,new), which
    // enchantment_table.js, craft.js and ecosystem code wait on. The chest Window already has this natively.
    updateSlot (slot, item) {
      const old = this.slots[slot] || null
      this.slots[slot] = item || null
      this.emit('updateSlot', slot, old, item || null)
      this.emit('updateSlot:' + slot, old, item || null)
    },
    // prismarine-windows Window helper parity over the station slots (chest Windows have these natively). A matcher can
    // be an item type id or name.
    matches (it, itemType, metadata) { return it && (it.type === itemType || it.name === itemType) && (metadata == null || it.metadata === metadata) },
    count (itemType, metadata) { return (this.slots || []).reduce((n, it) => n + (this.matches(it, itemType, metadata) ? it.count : 0), 0) },
    findContainerItem (itemType, metadata) { return (this.slots || []).find(it => this.matches(it, itemType, metadata)) || null },
    findInventoryItem (itemType, metadata) { return (bot.inventory ? bot.inventory.items() : []).find(it => this.matches(it, itemType, metadata)) || null },
    emptySlotCount () { return (this.slots || []).filter(s => !s).length },
    firstEmptySlotRange (start, end) { for (let s = start; s < end; s++) if (!this.slots[s]) return s; return null },
    // Java window action methods, delegating to the tested bot-level helpers (station player-inventory merge is not
    // modelled on Bedrock, so these operate on the open container + the real bot.inventory).
    withdraw (itemType, metadata, count, nbt) { return bot.withdraw ? bot.withdraw(itemType, metadata, count) : Promise.resolve() },
    deposit (itemType, metadata, count, nbt) { return bot.deposit ? bot.deposit(itemType, metadata, count) : Promise.resolve() },
    close () { return bot.closeWindow ? bot.closeWindow(this) : undefined }
  })

  bot._client.on('container_open', (packet) => {
    if (isChestType(packet.window_type)) {
      // Defer: build the real Window once inventory_content tells us the container slot count. openContainer/openAndWait
      // poll bot.currentWindow, which is set a beat later when the contents arrive (well within their deadlines).
      pendingChest = { id: packet.window_id, type: packet.window_type, position: packet.coordinates ? { x: packet.coordinates.x, y: packet.coordinates.y, z: packet.coordinates.z } : null, entityId: packet.runtime_entity_id }
      return
    }
    bot.currentWindow = plainWindow(packet)
    bot.emit('windowOpen', bot.currentWindow)
  })

  bot._client.on('inventory_content', (packet) => {
    // Build the chest Window on the first content for the pending open.
    if (pendingChest && packet.window_id === pendingChest.id) {
      const items = (packet.input || []).map(decode)
      const N = items.length || 27
      const win = windowsLoader.createWindow(pendingChest.id, 'minecraft:container', 'Container', N)
      win.bedrockType = pendingChest.type
      win.position = pendingChest.position
      win.entityId = pendingChest.entityId
      for (let s = 0; s < N; s++) { const it = items[s]; if (it) it.slot = s; win.slots[s] = it || null }
      syncPlayerIntoWindow(win)
      attachInvMirror(win)
      pendingChest = null
      bot.currentWindow = win
      bot.emit('windowOpen', win)
      bot.emit('windowUpdate', win)
      return
    }
    const w = bot.currentWindow
    if (!w || packet.window_id !== w.id) return
    if (w.inventoryStart != null) {
      // Chest Window: refresh the container section only (slots 0..inventoryStart-1). Route each change through
      // updateSlot so updateSlot/updateSlot:<i> fire (ecosystem parity) only when the slot actually changed.
      const items = (packet.input || []).map(decode)
      for (let s = 0; s < w.inventoryStart; s++) {
        const it = items[s]; if (it) it.slot = s
        const prev = w.slots[s] || null
        if ((prev && prev.stackId) !== (it && it.stackId) || (prev && prev.count) !== (it && it.count) || (!prev) !== (!it)) w.updateSlot(s, it || null)
      }
      bot.emit('windowUpdate', w)
      return
    }
    // Plain/station window: full refresh, then fire per-slot updateSlot for the changed cells.
    const next = (packet.input || []).map(decode)
    const prevSlots = w.slots || []
    w.slots = next
    if (typeof w.updateSlot === 'function') {
      const n = Math.max(prevSlots.length, next.length)
      for (let s = 0; s < n; s++) {
        const prev = prevSlots[s] || null; const it = next[s] || null
        if ((prev && prev.stackId) !== (it && it.stackId) || (prev && prev.count) !== (it && it.count) || (!prev) !== (!it)) { w.emit('updateSlot', s, prev, it); w.emit('updateSlot:' + s, prev, it) }
      }
    }
    bot.emit('windowUpdate', w)
  })

  // A single slot changed in the open container (e.g. after a deposit/withdraw the server confirms each side). The
  // player-inventory window ids ('inventory'/'armor'/'offhand') are owned by the inventory plugin; here we only take
  // the numeric window id of the open container.
  bot._client.on('inventory_slot', (packet) => {
    const w = bot.currentWindow
    if (!w || packet.window_id !== w.id) return
    const it = decode(packet.item)
    if (it) it.slot = packet.slot
    if (typeof w.updateSlot === 'function') w.updateSlot(packet.slot, it || null) // fires updateSlot/updateSlot:<i>
    else w.slots[packet.slot] = it || null
    bot.emit('windowUpdate', w, packet.slot)
  })

  bot._client.on('container_set_data', (packet) => {
    if (bot.currentWindow && packet.window_id === bot.currentWindow.id) {
      if (!bot.currentWindow.properties) bot.currentWindow.properties = {}
      bot.currentWindow.properties[packet.property] = packet.value
    }
    bot.emit('containerProperty', packet.window_id, packet.property, packet.value)
  })

  bot._client.on('container_close', (packet) => {
    const w = bot.currentWindow
    detachInvMirror()
    pendingChest = null
    bot.currentWindow = null
    if (w) bot.emit('windowClose', w)
  })

  // Close the current (or given) container. Bedrock echoes with its own container_close, which fires windowClose.
  bot.closeWindow = (window) => {
    const w = window || bot.currentWindow
    if (!w) return
    send('container_close', { window_id: w.id, window_type: w.bedrockType ?? w.type ?? 'none', server: false })
    detachInvMirror()
    bot.currentWindow = null
    bot.emit('windowClose', w)
  }

  // Open a container block (chest, furnace, ...). Uses the interact plugin's click_block; the server replies with
  // container_open. Best used with an empty hand so the click is not treated as a block placement.
  bot.openContainer = (block) => {
    if (typeof bot.activateBlock !== 'function') throw new Error('openContainer needs the interact plugin')
    return bot.activateBlock(block)
  }

  // --- Moving items in/out of the open container (deposit / withdraw) ---
  // Bedrock moves items with item_stack_request: one 'place' action carrying a source and a destination slot, each a
  // {slot_type:{container_id}, slot, stack_id}. The open container's slots use container_id 'container'; the player's
  // use 'hotbar' (bedrock slots 0-8) and 'inventory' (9-35). The source stack_id must be the item's runtime stack id
  // (items carry .stackId); the server replies with item_stack_response (status 'ok' on success) and the authoritative
  // slot updates. Slot descriptors + flow verified live against BDS 1.26.45 (same request shape crafting.js uses).
  if (!bot._stackRequest) bot._stackRequest = { id: 1 }
  const nextStackId = () => { bot._stackRequest.id -= 2; return bot._stackRequest.id }
  const bedrockOf = (playerIndex) => playerIndex >= QUICK_BAR_START ? playerIndex - QUICK_BAR_START : playerIndex
  const playerSlotOf = (bedrockSlot) => bedrockSlot < 9 ? QUICK_BAR_START + bedrockSlot : bedrockSlot
  const invContainer = (bedrockSlot) => bedrockSlot < 9 ? 'hotbar' : 'inventory'
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const PItem = () => require('prismarine-item')(bot.registry)

  const pending = new Map()
  bot._client.on('item_stack_response', (packet) => {
    for (const response of packet.responses || []) {
      const p = pending.get(response.request_id)
      if (!p) continue
      pending.delete(response.request_id)
      p(response)
    }
  })
  const sendRequest = (actions) => {
    const id = nextStackId()
    return new Promise((resolve) => { pending.set(id, resolve); send('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [], cause: -1 }] }) })
  }
  // The count of container slots (0..containerSize-1) in the open window - the Window's inventoryStart, or the plain
  // window's slots length (which for a plain window holds only container items).
  const containerSize = (w) => (w.inventoryStart != null ? w.inventoryStart : (w.slots.length || 27))
  const firstFreeContainerSlot = (w) => { const n = containerSize(w); for (let s = 0; s < n; s++) if (!w.slots[s]) return s; return null }
  const resolveInvItem = (itemType) => {
    if (itemType && typeof itemType === 'object') return itemType
    const items = bot.inventory.items()
    return items.find(i => i.name === itemType || i.type === itemType || (typeof itemType === 'string' && i.name === itemType.replace(/^minecraft:/, ''))) || null
  }

  // Deposit an inventory item into the open container. itemType is a name, a numeric id, or a prismarine-item.
  bot.deposit = async (itemType, metadata = null, count = null) => {
    const w = bot.currentWindow
    if (!w) throw new Error('deposit: no container is open')
    const src = resolveInvItem(itemType)
    if (!src) throw new Error('deposit: that item is not in the inventory')
    const moveCount = count ?? src.count
    const fromBedrock = bedrockOf(src.slot)
    const destSlot = firstFreeContainerSlot(w)
    if (destSlot == null) throw new Error('deposit: the container is full')
    const response = await sendRequest([{
      type_id: 'place',
      legacy_type_id: 1,
      count: moveCount,
      source: { slot_type: { container_id: invContainer(fromBedrock) }, slot: fromBedrock, stack_id: src.stackId ?? 0 },
      destination: { slot_type: { container_id: 'container' }, slot: destSlot, stack_id: 0 }
    }])
    if (response.status !== 'ok') throw new Error(`deposit: rejected (status ${response.status})`)
    // Apply the player side: reduce the source stack by moveCount (the container side reconciles via inventory_slot; the
    // inventory mirror keeps the chest Window's player section in sync).
    const pSlot = playerSlotOf(fromBedrock)
    const inv = bot.inventory.slots[pSlot]
    if (inv) { inv.count -= moveCount; bot.inventory.updateSlot(pSlot, inv.count > 0 ? inv : null) }
    await wait(150)
    return response
  }

  // Withdraw an item from the open container into the player inventory. itemType is a name, id, or prismarine-item.
  bot.withdraw = async (itemType, metadata = null, count = null) => {
    const w = bot.currentWindow
    if (!w) throw new Error('withdraw: no container is open')
    const n = containerSize(w)
    let srcSlot
    if (itemType && typeof itemType === 'object' && itemType.slot != null && w.slots[itemType.slot] === itemType) srcSlot = itemType.slot
    else { srcSlot = -1; for (let s = 0; s < n; s++) { const it = w.slots[s]; if (it && (it.name === itemType || it.type === itemType || (typeof itemType === 'string' && it.name === itemType.replace(/^minecraft:/, '')))) { srcSlot = s; break } } }
    if (srcSlot == null || srcSlot < 0 || !w.slots[srcSlot]) throw new Error('withdraw: that item is not in the container')
    const item = w.slots[srcSlot]
    const moveCount = count ?? item.count
    // Find a free player slot (inventory 9-35 first, then hotbar 0-8) to place it into.
    let destBedrock = null
    for (let s = 9; s < 36 && destBedrock == null; s++) if (!bot.inventory.slots[s]) destBedrock = s
    for (let s = 0; s < 9 && destBedrock == null; s++) if (!bot.inventory.slots[QUICK_BAR_START + s]) destBedrock = s
    if (destBedrock == null) throw new Error('withdraw: no free inventory slot')
    const response = await sendRequest([{
      type_id: 'take',
      legacy_type_id: 0,
      count: moveCount,
      source: { slot_type: { container_id: 'container' }, slot: srcSlot, stack_id: item.stackId ?? 0 },
      destination: { slot_type: { container_id: invContainer(destBedrock) }, slot: destBedrock, stack_id: 0 }
    }])
    if (response.status !== 'ok') throw new Error(`withdraw: rejected (status ${response.status})`)
    // Apply the player side: add moveCount to the destination slot (merge if the same item is already there).
    const pSlot = playerSlotOf(destBedrock)
    const existing = bot.inventory.slots[pSlot]
    if (existing && (existing.type === item.type || existing.name === item.name)) {
      existing.count += moveCount
      bot.inventory.updateSlot(pSlot, existing)
    } else {
      const Item = PItem()
      bot.inventory.updateSlot(pSlot, new Item(item.type, moveCount, item.metadata ?? 0))
    }
    await wait(150)
    return response
  }
}
