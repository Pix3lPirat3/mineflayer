module.exports = inject

// Bedrock containers (chests, furnaces, ...). The server opens a container with container_open, streams its items with
// inventory_content for that window id, reports progress fields with container_set_data, and ends it with
// container_close. Opening one is a click_block on the container (bot.openContainer -> the interact plugin's
// activateBlock); the server then drives the rest. Packet shapes verified against a relay capture.
function inject (bot) {
  const send = (name, packet) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, packet); else bot._client.write(name, packet) }

  bot._client.on('container_open', (packet) => {
    bot.currentWindow = {
      id: packet.window_id,
      type: packet.window_type,
      position: packet.coordinates ? { x: packet.coordinates.x, y: packet.coordinates.y, z: packet.coordinates.z } : null,
      entityId: packet.runtime_entity_id,
      slots: [],
      properties: {}
    }
    bot.emit('windowOpen', bot.currentWindow)
  })

  bot._client.on('inventory_content', (packet) => {
    const w = bot.currentWindow
    if (!w || packet.window_id !== w.id) return
    w.slots = (packet.input || []).map(it => (bot._bedrockItemFromNotch ? bot._bedrockItemFromNotch(it) : it) || null)
    bot.emit('windowUpdate', w)
  })

  // A single slot changed in the open container (e.g. after a deposit/withdraw the server confirms each side). The
  // player-inventory window ids ('inventory'/'armor'/'offhand') are owned by the inventory plugin; here we only take
  // the numeric window id of the open container.
  bot._client.on('inventory_slot', (packet) => {
    const w = bot.currentWindow
    if (!w || packet.window_id !== w.id) return
    w.slots[packet.slot] = (bot._bedrockItemFromNotch ? bot._bedrockItemFromNotch(packet.item) : packet.item) || null
    bot.emit('windowUpdate', w, packet.slot)
  })

  bot._client.on('container_set_data', (packet) => {
    if (bot.currentWindow && packet.window_id === bot.currentWindow.id) bot.currentWindow.properties[packet.property] = packet.value
    bot.emit('containerProperty', packet.window_id, packet.property, packet.value)
  })

  bot._client.on('container_close', (packet) => {
    const w = bot.currentWindow
    bot.currentWindow = null
    if (w) bot.emit('windowClose', w)
  })

  // Close the current (or given) container. Bedrock echoes with its own container_close, which fires windowClose.
  bot.closeWindow = (window) => {
    const w = window || bot.currentWindow
    if (!w) return
    send('container_close', { window_id: w.id, window_type: w.type ?? 'none', server: false })
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
  const QUICK_BAR_START = 36
  const bedrockOf = (playerIndex) => playerIndex >= QUICK_BAR_START ? playerIndex - QUICK_BAR_START : playerIndex
  const playerSlotOf = (bedrockSlot) => bedrockSlot < 9 ? QUICK_BAR_START + bedrockSlot : bedrockSlot
  const invContainer = (bedrockSlot) => bedrockSlot < 9 ? 'hotbar' : 'inventory'
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  // Item stack requests carry the player-inventory changes back in the item_stack_response, not as separate
  // inventory_slot packets (unlike the open container's own slots, which the server does echo). So apply the player
  // side to bot.inventory ourselves after a successful move.
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
  const firstFreeContainerSlot = (w) => {
    const size = w.slots.length || 27
    for (let s = 0; s < size; s++) if (!w.slots[s]) return s
    return null
  }
  const resolveInvItem = (itemType, metadata) => {
    if (itemType && typeof itemType === 'object') return itemType
    const items = bot.inventory.items()
    return items.find(i => i.name === itemType || i.type === itemType || (typeof itemType === 'string' && i.name === itemType.replace(/^minecraft:/, ''))) || null
  }

  // Deposit an inventory item into the open container. itemType is a name, a numeric id, or a prismarine-item.
  bot.deposit = async (itemType, metadata = null, count = null) => {
    const w = bot.currentWindow
    if (!w) throw new Error('deposit: no container is open')
    const src = resolveInvItem(itemType, metadata)
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
    // Apply the player side: reduce the source stack by moveCount (the container side reconciles via inventory_slot).
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
    let srcSlot
    if (itemType && typeof itemType === 'object' && itemType.slot != null && w.slots[itemType.slot] === itemType) srcSlot = itemType.slot
    else srcSlot = w.slots.findIndex(it => it && (it.name === itemType || it.type === itemType || (typeof itemType === 'string' && it.name === itemType.replace(/^minecraft:/, ''))))
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
