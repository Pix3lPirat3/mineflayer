const assert = require('assert')

module.exports = inject

const QUICK_BAR_START = 36
const QUICK_BAR_COUNT = 9
const ARMOR_SLOTS = [5, 6, 7, 8]
const OFFHAND_SLOT = 45

function inject (bot) {
  const Item = require('prismarine-item')(bot.registry)
  const windows = require('prismarine-windows')(bot.registry)
  const networkToCanonical = new Map()
  const canonicalToNetwork = new Map()

  bot.quickBarSlot = 0
  bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  bot.currentWindow = null
  bot.QUICK_BAR_START = QUICK_BAR_START

  Object.defineProperty(bot, 'heldItem', {
    get: () => bot.inventory.slots[QUICK_BAR_START + bot.quickBarSlot]
  })

  bot.updateHeldItem = () => bot.emit('heldItemChanged', bot.heldItem)
  bot.getEquipmentDestSlot = destination => {
    const slot = {
      hand: QUICK_BAR_START + bot.quickBarSlot,
      head: 5,
      torso: 6,
      legs: 7,
      feet: 8,
      'off-hand': OFFHAND_SLOT
    }[destination]
    assert.ok(slot != null, `invalid destination: ${destination}`)
    return slot
  }

  bot.setQuickBarSlot = slot => {
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot < QUICK_BAR_COUNT, 'slot must be between 0 and 8')
    if (bot.quickBarSlot === slot) return
    bot.quickBarSlot = slot
    const packet = {
      runtime_entity_id: compatibleRuntimeId(bot.entity?.id ?? bot._client.entityId ?? 0),
      item: toNotch(bot.heldItem),
      slot,
      selected_slot: slot,
      window_id: 'inventory'
    }
    if (typeof bot._client.queue === 'function') bot._client.queue('mob_equipment', packet)
    else bot._client.write('mob_equipment', packet)
    syncLocalEquipment()
    bot.updateHeldItem()
  }

  // Inventory item moving via item_stack_request (verified shape from a relay capture). Slots are Bedrock inventory
  // slots (0-8 hotbar, 9-35 main); container_id hotbar_and_inventory addresses the whole player inventory. The server
  // validates the stack ids, so we read them from the current slots. Client request ids are negative and odd.
  let stackRequestId = 1
  const nextRequestId = () => { stackRequestId -= 2; return stackRequestId }
  // Bedrock addresses the hotbar (slots 0-8) and the main inventory (slots 9-35 -> container slots 0-26) as separate
  // containers in item_stack_request, matching the real client.
  const slotInfo = (bedrockSlot, stackId) => {
    const container = bedrockSlot < QUICK_BAR_COUNT ? 'hotbar' : 'inventory'
    const slot = bedrockSlot < QUICK_BAR_COUNT ? bedrockSlot : bedrockSlot - QUICK_BAR_COUNT
    return { slot_type: { container_id: container }, slot, stack_id: stackId ?? 0 }
  }
  const sendStack = (name, packet) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, packet); else bot._client.write(name, packet) }

  const pendingStackRequests = new Map()

  bot.moveInventoryItem = (fromSlot, toSlot, count) => {
    const src = bot.inventory.slots[playerSlot(fromSlot)]
    if (!src) throw new Error('moveInventoryItem: source slot is empty')
    const dst = bot.inventory.slots[playerSlot(toSlot)]
    const requestId = nextRequestId()
    const action = dst
      ? { type_id: 'swap', legacy_type_id: 2, source: slotInfo(fromSlot, src.stackId), destination: slotInfo(toSlot, dst.stackId) }
      : { type_id: 'place', legacy_type_id: 1, count: count ?? src.count, source: slotInfo(fromSlot, src.stackId), destination: slotInfo(toSlot, 0) }
    pendingStackRequests.set(requestId, { from: fromSlot, to: toSlot, swap: !!dst })
    sendStack('item_stack_request', { requests: [{ request_id: requestId, actions: [action], custom_names: [], cause: -1 }] })
    return requestId
  }

  // The server confirms an item_stack_request with an item_stack_response and does not resend the slots, so on success
  // we apply the move locally (the response carries the new counts/stack ids per slot).
  bot._client.on('item_stack_response', packet => {
    for (const response of packet.responses || []) {
      const req = pendingStackRequests.get(response.request_id)
      pendingStackRequests.delete(response.request_id)
      if (response.status === 'ok' && req) {
        const fromP = playerSlot(req.from)
        const toP = playerSlot(req.to)
        const fromItem = bot.inventory.slots[fromP]
        const toItem = bot.inventory.slots[toP]
        if (req.swap) { bot.inventory.updateSlot(fromP, toItem || null); bot.inventory.updateSlot(toP, fromItem || null) } else { bot.inventory.updateSlot(toP, fromItem || null); bot.inventory.updateSlot(fromP, null) }
        applyStackIds(response)
        syncLocalEquipment()
        bot.updateHeldItem()
      }
      bot.emit('itemStackResponse', response.status, response.request_id, response)
    }
  })

  // Update local slot counts / stack ids from a successful response's container slots.
  function applyStackIds (response) {
    for (const container of response.containers || []) {
      for (const s of container.slots || []) {
        const bedrockSlot = container.slot_type.container_id === 'hotbar' ? s.slot : QUICK_BAR_COUNT + s.slot
        const p = playerSlot(bedrockSlot)
        const item = bot.inventory.slots[p]
        if (s.count === 0) { bot.inventory.updateSlot(p, null) } else if (item) { item.count = s.count; if (s.item_stack_id != null) item.stackId = s.item_stack_id }
      }
    }
  }

  bot._client.on('item_registry', packet => registerItems(packet.itemstates))
  bot._client.on('start_game', packet => registerItems(packet.itemstates))
  bot._bedrockItemFromNotch = fromNotch
  bot._bedrockItemToNotch = toNotch

  bot._client.on('inventory_content', packet => {
    if (packet.window_id === 'inventory') {
      for (let slot = 0; slot < 36; slot++) setInventorySlot(playerSlot(slot), packet.input[slot])
    } else if (packet.window_id === 'armor') {
      for (let slot = 0; slot < ARMOR_SLOTS.length; slot++) setInventorySlot(ARMOR_SLOTS[slot], packet.input[slot])
    } else if (packet.window_id === 'offhand') {
      setInventorySlot(OFFHAND_SLOT, packet.input[0])
    } else {
      return
    }
    syncLocalEquipment()
    bot.emit(`setWindowItems:${packet.window_id}`)
  })

  bot._client.on('inventory_slot', packet => {
    const slot = windowSlot(packet.window_id, packet.slot)
    if (slot == null) return
    setInventorySlot(slot, packet.item)
    syncLocalEquipment()
  })

  bot._client.on('player_hotbar', packet => {
    if (!packet.select_slot || packet.window_id !== 'inventory') return
    bot.quickBarSlot = packet.selected_slot
    syncLocalEquipment()
    bot.updateHeldItem()
  })

  bot._client.on('mob_equipment', packet => {
    const entity = bot.entities[Number(packet.runtime_entity_id)]
    if (!entity) return
    entity.setEquipment(0, fromNotch(packet.item))
    bot.emit('entityEquip', entity)
  })

  bot._client.on('mob_armor_equipment', packet => {
    const entity = bot.entities[Number(packet.runtime_entity_id)]
    if (!entity) return
    for (const [index, name] of ['helmet', 'chestplate', 'leggings', 'boots'].entries()) {
      entity.setEquipment(index + 1, fromNotch(packet[name]))
    }
    bot.emit('entityEquip', entity)
  })

  function setInventorySlot (slot, networkItem) {
    bot.inventory.updateSlot(slot, fromNotch(networkItem))
  }

  function fromNotch (networkItem) {
    if (!networkItem || networkItem.network_id === 0) return null
    // minecraft-data does not publish item definitions for the oldest Bedrock
    // registries. Keep those sessions usable without inventing item metadata.
    if (!bot.registry.itemsByName) return null
    const networkId = networkItem.network_id
    const item = Item.fromNotch({
      ...networkItem,
      network_id: networkToCanonical.get(networkId) ?? networkId
    })
    item.networkId = networkId
    // prismarine-item does not round-trip the block form's runtime id, but the server validates item-use/placement
    // transactions against its own item record, which carries it. Keep it so toNotch can reproduce the exact record.
    item.blockRuntimeId = networkItem.block_runtime_id
    return item
  }

  function toNotch (item) {
    const networkItem = Item.toNotch(item)
    if (item) {
      networkItem.network_id = item.networkId ?? canonicalToNetwork.get(item.type) ?? item.type
      if (item.blockRuntimeId != null) networkItem.block_runtime_id = item.blockRuntimeId
    }
    return networkItem
  }

  function registerItems (itemstates = []) {
    const itemsByName = bot.registry.itemsByName || {}
    for (const state of itemstates) {
      const item = itemsByName[state.name.replace(/^minecraft:/, '')]
      if (!item) continue
      networkToCanonical.set(state.runtime_id, item.id)
      canonicalToNetwork.set(item.id, state.runtime_id)
    }
  }

  function syncLocalEquipment () {
    if (!bot.entity) return
    bot.entity.setEquipment(0, bot.heldItem)
    for (let index = 0; index < ARMOR_SLOTS.length; index++) {
      bot.entity.setEquipment(index + 1, bot.inventory.slots[ARMOR_SLOTS[index]])
    }
  }

  function compatibleRuntimeId (runtimeId) {
    return bot._client.options?.version === '1.16.201' ? Number(runtimeId) : BigInt(runtimeId)
  }
}

function playerSlot (slot) {
  return slot < QUICK_BAR_COUNT ? QUICK_BAR_START + slot : slot
}

function windowSlot (windowId, slot) {
  if (windowId === 'inventory') return playerSlot(slot)
  if (windowId === 'armor' && slot < ARMOR_SLOTS.length) return ARMOR_SLOTS[slot]
  if (windowId === 'offhand' && slot === 0) return OFFHAND_SLOT
  return null
}
