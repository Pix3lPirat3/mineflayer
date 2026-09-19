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
    return item
  }

  function toNotch (item) {
    const networkItem = Item.toNotch(item)
    if (item) networkItem.network_id = item.networkId ?? canonicalToNetwork.get(item.type) ?? item.type
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
