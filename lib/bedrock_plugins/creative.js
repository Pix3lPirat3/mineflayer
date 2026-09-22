module.exports = inject

// Bedrock creative inventory (bot.creative), the edition-native replacement for Java's set_creative_slot. On Bedrock the
// server streams every creative item once during join in `creative_content` (groups + items, each item carrying an
// `entry_id` = its creative network id). To put an item in a slot the client sends an item_stack_request with a
// `craft_creative` action (item_id = that entry_id) which produces the stack in the virtual `creative_output` slot 50,
// then a `take` from slot 50 into the destination inventory slot. To clear a slot it sends a `destroy` action. This
// mirrors mineflayer's bot.creative.{setInventorySlot, clearSlot, clearInventory} so tests and the PoC no longer need the
// /give op command. Slot indices are Java-layout (mineflayer's bot.inventory: 9-35 main, 36-44 hotbar); the bedrock
// protocol uses hotbar 0-8 + inventory 9-35, converted here (same mapping the containers/crafting plugins use).
function inject (bot) {
  bot.creative = bot.creative || {}
  const send = (name, packet) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, packet); else bot._client.write(name, packet) }
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const QUICK_BAR_START = 36
  const bedrockOf = (javaSlot) => javaSlot >= QUICK_BAR_START ? javaSlot - QUICK_BAR_START : javaSlot
  const playerSlot = (bedrockSlot) => bedrockSlot < 9 ? QUICK_BAR_START + bedrockSlot : bedrockSlot
  const invContainer = (bedrockSlot) => bedrockSlot < 9 ? 'hotbar' : 'inventory'
  const PItem = () => require('prismarine-item')(bot.registry)

  // Attach the server's authoritative stack ids from an item_stack_response to the player-inventory items (same as the
  // inventory plugin). Without this a slot we just filled carries no stackId, and a later destroy is rejected (status 49).
  const applyStackIds = (response) => {
    for (const container of response.containers || []) {
      const cid = container.slot_type?.container_id
      if (cid !== 'hotbar' && cid !== 'inventory') continue
      for (const s of container.slots || []) {
        const item = bot.inventory.slots[playerSlot(s.slot)]
        if (item && s.item_stack_id != null) item.stackId = s.item_stack_id
      }
    }
  }

  // name -> creative entry_id (first entry wins; enough for give-by-name). Built once from creative_content at join.
  const entryByName = new Map()
  let contentReady = false
  bot._client.on('creative_content', (packet) => {
    entryByName.clear()
    for (const e of (packet.items || [])) {
      if (e.entry_id == null || !e.item) continue
      const it = bot._bedrockItemFromNotch ? bot._bedrockItemFromNotch(e.item) : null
      const name = it && it.name
      if (name && !entryByName.has(name)) entryByName.set(name, e.entry_id)
    }
    contentReady = true
    bot.emit('creativeContentReady', entryByName.size)
  })

  // Share the containers/crafting plugin's item_stack_request id space + response routing if present, so ids never clash.
  if (!bot._stackRequest) bot._stackRequest = { id: 1 }
  const nextStackId = () => { bot._stackRequest.id -= 2; return bot._stackRequest.id }
  const pending = new Map()
  bot._client.on('item_stack_response', (packet) => {
    for (const response of packet.responses || []) {
      const p = pending.get(response.request_id)
      if (!p) continue
      pending.delete(response.request_id)
      p(response)
    }
  })
  // Send an item_stack_request whose actions are built from the allocated id (the creative_output stack carries the
  // request id as its stack id, exactly as crafting.js relies on). buildActions(id) returns the action list.
  const sendRequest = (buildActions) => {
    const id = nextStackId()
    const actions = buildActions(id)
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('item_stack_request: no item_stack_response from the server')) }, 4000)
      pending.set(id, (response) => { clearTimeout(timer); resolve(response) })
    })
    send('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [], cause: -1 }] })
    return done.then(response => ({ id, response }))
  }

  const toItem = (item) => {
    if (item == null) return null
    if (typeof item === 'object' && item.name) return item
    const Item = PItem()
    const def = typeof item === 'string' ? bot.registry.itemsByName[item.replace(/^minecraft:/, '')] : bot.registry.items[item]
    if (!def) throw new Error(`creative: unknown item '${item}'`)
    return new Item(def.id, 1, 0)
  }

  // Put `item` (a prismarine-item, an item name, or a numeric id) into Java inventory slot `slot`, or clear it with null.
  bot.creative.setInventorySlot = async (slot, item, waitTimeout = 5000) => {
    if (!(slot >= 0 && slot <= 44)) throw new Error('creative.setInventorySlot: slot must be 0-44')
    const target = toItem(item)
    const bedrockSlot = bedrockOf(slot)
    const container = invContainer(bedrockSlot)

    if (target == null) {
      // Clear: destroy whatever is in the slot. Like craft_creative, the item_stack_request is processed against the
      // open inventory screen, so open it if nothing is open and close it after.
      if (!bot.inventory.slots[slot]) return
      const openedInv = !bot.currentWindow && typeof bot.openInventory === 'function'
      // Opening the inventory makes the server stream inventory_content with the REAL stack ids, so re-read the slot
      // afterwards - a slot we mirrored on give carries no server stackId, and destroy with the wrong stack_id is
      // rejected (status 49).
      if (openedInv) { bot.openInventory(); await wait(500) }
      const current = bot.inventory.slots[slot]
      if (!current) { if (openedInv && bot.currentWindow && typeof bot.closeWindow === 'function') { try { bot.closeWindow(bot.currentWindow) } catch {} } return }
      const { response } = await sendRequest(() => [{ type_id: 'destroy', legacy_type_id: 4, count: current.count, source: { slot_type: { container_id: container }, slot: bedrockSlot, stack_id: current.stackId ?? 0 } }])
      if (openedInv && bot.currentWindow && typeof bot.closeWindow === 'function') { try { bot.closeWindow(bot.currentWindow) } catch {} await wait(150) }
      if (response.status !== 'ok') throw new Error(`creative.setInventorySlot(clear): rejected (status ${response.status})`)
      bot.inventory.updateSlot(slot, null)
      await wait(120)
      return
    }

    const entryId = entryByName.get(target.name)
    if (entryId == null) throw new Error(`creative.setInventorySlot: '${target.name}' is not in the server creative list${contentReady ? '' : ' (creative_content not received yet)'}`)
    const count = target.count || 1
    // The creative_output source is a cross-container slot, so the server needs the inventory screen open to process the
    // item_stack_request (same requirement the crafting/move helpers observe). Open it if nothing is open, and close it
    // after so it does not shadow a later openContainer (which polls bot.currentWindow).
    const openedInventory = !bot.currentWindow && typeof bot.openInventory === 'function'
    if (openedInventory) { bot.openInventory(); await wait(500) }
    const { response } = await sendRequest((id) => [
      // legacy_type_id is the stable ItemStackRequestActionType enum value the server reads: craft_creative = 14
      // (take = 0, place = 1, destroy = 4, consume = 5, craft_recipe = 12). Using the wrong value makes the server read
      // the action body with the wrong layout and silently drop the whole request.
      { type_id: 'craft_creative', legacy_type_id: 14, item_id: entryId, times_crafted: 1 },
      { type_id: 'take', legacy_type_id: 0, count, source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: id }, destination: { slot_type: { container_id: container }, slot: bedrockSlot, stack_id: 0 } }
    ])
    if (openedInventory && bot.currentWindow && typeof bot.closeWindow === 'function') { try { bot.closeWindow(bot.currentWindow) } catch {} await wait(150) }
    if (response.status !== 'ok') throw new Error(`creative.setInventorySlot: rejected (status ${response.status})`)
    // Mirror into bot.inventory (the server placed it in the destination slot), then stamp the authoritative stack id
    // from the response so the slot is destroyable/moveable afterwards.
    bot.inventory.updateSlot(slot, new (PItem())(target.type ?? target.id, count, target.metadata ?? 0))
    applyStackIds(response)
    await wait(150)
  }

  bot.creative.clearSlot = (slot) => bot.creative.setInventorySlot(slot, null)
  bot.creative.clearInventory = () => Promise.all(bot.inventory.slots.map((it, slot) => it ? bot.creative.clearSlot(slot) : null).filter(Boolean))

  // Convenience (not in the Java API): give an item into the first free hotbar/inventory slot, returning the slot used.
  // This is the ergonomic /give replacement the harness + PoC want.
  bot.creative.give = async (item, count = 1) => {
    const target = toItem(item); if (target) target.count = count
    let slot = null
    for (let s = 36; s <= 44 && slot == null; s++) if (!bot.inventory.slots[s]) slot = s
    for (let s = 9; s <= 35 && slot == null; s++) if (!bot.inventory.slots[s]) slot = s
    if (slot == null) throw new Error('creative.give: no free inventory slot')
    await bot.creative.setInventorySlot(slot, target)
    return slot
  }
}
