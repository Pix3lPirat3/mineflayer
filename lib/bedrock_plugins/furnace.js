module.exports = inject

// Furnace smelting. Verified server-authoritative flow (BDS 1.26.45): open the furnace (container_open, window type
// 'furnace'), place the smeltable into furnace_ingredient slot 0 and the fuel into furnace_fuel slot 1 with
// item_stack_request 'place'; the server smelts over time (progress arrives as container_set_data -> containerProperty)
// and fills furnace_output slot 2, which is taken out with 'take'. The furnace slot numbers match the window layout
// (ingredient 0, fuel 1, output 2), each addressed with its own container id. bot.smelt drives the whole cycle.
//
// A blast furnace and a smoker work the same way, in a window of their own type ('blast_furnace', 'smoker'). Only the
// ingredient slot has its own container id there (blast_furnace_ingredient, smoker_ingredient); the fuel and output
// slots are furnace_fuel and furnace_output as in a furnace. Both smelt in half the time, 100 ticks an item.
const INGREDIENT = { furnace: 'furnace_ingredient', blast_furnace: 'blast_furnace_ingredient', smoker: 'smoker_ingredient' }
const SMELT_TICKS = { furnace: 200, blast_furnace: 100, smoker: 100 }
const isFurnaceWindow = (w) => !!w && Object.prototype.hasOwnProperty.call(INGREDIENT, w.type)
// The open window's ingredient container id. With no furnace window open, a furnace's, as before.
const ingredientOf = (w) => (isFurnaceWindow(w) ? INGREDIENT[w.type] : INGREDIENT.furnace)

function inject (bot) {
  const QUICK_BAR_START = 36
  const playerSlot = (bedrockSlot) => bedrockSlot < 9 ? QUICK_BAR_START + bedrockSlot : bedrockSlot
  const invContainer = (bedrockSlot) => bedrockSlot < 9 ? 'hotbar' : 'inventory'
  const send = (name, packet) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, packet); else bot._client.write(name, packet) }

  if (!bot._stackRequest) bot._stackRequest = { id: 1 }
  const nextStackId = () => { bot._stackRequest.id -= 2; return bot._stackRequest.id }
  const pending = new Map()
  bot._client.on('item_stack_response', (packet) => {
    for (const response of packet.responses || []) {
      const resolve = pending.get(response.request_id)
      if (!resolve) continue
      pending.delete(response.request_id)
      resolve(response)
    }
  })
  const sendRequest = (actions) => {
    const id = nextStackId()
    return new Promise((resolve) => { pending.set(id, resolve); send('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [], cause: -1 }] }) }).then(response => ({ id, response, status: response.status }))
  }
  const findItem = (name) => (bot.inventory?.items?.() || []).find(i => i.name === name)
  const firstFreeBedrockSlot = () => { for (let s = 0; s < 36; s++) if (!bot.inventory.slots[playerSlot(s)]) return s; return null }

  const placeInto = async (item, containerId, slot, count) => {
    const from = item.slot >= QUICK_BAR_START ? item.slot - QUICK_BAR_START : item.slot
    const { status } = await sendRequest([{ type_id: 'place', legacy_type_id: 1, count: count ?? 1, source: { slot_type: { container_id: invContainer(from) }, slot: from, stack_id: item.stackId ?? 0 }, destination: { slot_type: { container_id: containerId }, slot, stack_id: 0 } }])
    if (status !== 'ok') throw new Error(`furnace: could not place ${item.name} into ${containerId} (status ${status})`)
    const p = playerSlot(from)
    const inv = bot.inventory.slots[p]
    if (inv) { inv.count -= (count ?? 1); if (inv.count <= 0) bot.inventory.updateSlot(p, null) }
  }

  // Put a smeltable / fuel into an already-open furnace, blast furnace or smoker (bot.currentWindow must be one).
  bot.putSmeltable = async (itemName, count = 1) => { const it = findItem(itemName); if (!it) throw new Error(`furnace: no ${itemName} to smelt`); return placeInto(it, ingredientOf(bot.currentWindow), 0, count) }
  bot.putFuel = async (itemName, count = 1) => { const it = findItem(itemName); if (!it) throw new Error(`furnace: no ${itemName} for fuel`); return placeInto(it, 'furnace_fuel', 1, count) }

  // Resolve a Java putInput/putFuel first arg (numeric item id, item object, or name) to an item name for putSmeltable.
  const nameOfItem = (itemType) => {
    if (itemType == null) return null
    if (typeof itemType === 'string') return itemType.replace(/^minecraft:/, '')
    if (typeof itemType === 'object') return itemType.name
    return bot.registry.items[itemType]?.name ?? null
  }
  // Take a station slot's stack out into a free inventory slot (Java furnace.takeInput/takeFuel/takeOutput). Returns the
  // taken item (or null if the slot is empty). window slots: ingredient 0, fuel 1, output 2.
  const takeFromFurnace = async (containerId, slot) => {
    const w = bot.currentWindow
    const held = w && w.slots && w.slots[slot]
    if (!held) return null
    const dest = firstFreeBedrockSlot()
    if (dest == null) throw new Error('furnace: no free inventory slot for the taken item')
    const id = nextStackId()
    const actions = [{ type_id: 'take', legacy_type_id: 0, count: held.count, source: { slot_type: { container_id: containerId }, slot, stack_id: held.stackId ?? id }, destination: { slot_type: { container_id: invContainer(dest) }, slot: dest, stack_id: 0 } }]
    const response = await new Promise((resolve) => { pending.set(id, resolve); send('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [], cause: -1 }] }) })
    if (response.status !== 'ok') throw new Error(`furnace: taking the item was rejected (status ${response.status})`)
    const Item = require('prismarine-item')(bot.registry)
    const result = new Item(held.type, held.count, held.metadata ?? 0)
    bot.inventory.updateSlot(playerSlot(dest), result)
    return result
  }

  // Java-parity furnace progress fields on the open window (bot.currentWindow.fuel/fuelSeconds/progress/... like
  // mineflayer-java's Furnace), fed by container_set_data. Bedrock's property indices differ from Java and are
  // verified live (BDS 1.26.45): 0 = smelt tick count (counts UP 0..200 per item) -> Java "current progress"; 1 = lit
  // time remaining (counts DOWN) -> Java "current fuel"; 2 = lit duration (total ticks for the current fuel) -> Java
  // "total fuel"; 3 = stored XP. Bedrock sends no "total progress"; a normal furnace smelts in 200 ticks (10s), a blast
  // furnace or a smoker in 100 (SMELT_TICKS).
  const toSeconds = t => (t == null ? null : t / 20)
  bot.on('windowOpen', (w) => {
    if (!isFurnaceWindow(w)) return
    w.totalFuel = w.fuel = w.fuelSeconds = w.totalFuelSeconds = null
    w.totalProgress = w.progress = w.progressSeconds = w.totalProgressSeconds = null
    w._litTime = null
    if (!w.inputItem) { w.inputItem = () => w.slots[0]; w.fuelItem = () => w.slots[1]; w.outputItem = () => w.slots[2] }
    // Java-parity furnace window methods (mineflayer-java's Furnace attaches these to the window). putInput/putFuel take
    // (itemType, metadata, count) like Java; take* return the removed item. Delegate to the tested bedrock primitives.
    if (!w.putInput) {
      w.putInput = (itemType, metadata, count = 1) => bot.putSmeltable(nameOfItem(itemType), count)
      w.putFuel = (itemType, metadata, count = 1) => bot.putFuel(nameOfItem(itemType), count)
      w.takeInput = () => takeFromFurnace(ingredientOf(w), 0)
      w.takeFuel = () => takeFromFurnace('furnace_fuel', 1)
      w.takeOutput = () => takeFromFurnace('furnace_output', 2)
    }
  })
  bot.on('containerProperty', (wid, prop, value) => {
    const w = bot.currentWindow
    if (!isFurnaceWindow(w) || w.id !== wid) return
    switch (prop) {
      case 0: { // smelt progress, counts up toward the kind's smelt time
        const total = SMELT_TICKS[w.type]
        w.totalProgress = total
        w.totalProgressSeconds = toSeconds(total)
        w.progress = value / total
        w.progressSeconds = toSeconds(total - value)
        break
      }
      case 1: // current fuel remaining, counts down
        w._litTime = value
        w.fuelSeconds = toSeconds(value)
        w.fuel = w.totalFuel ? value / w.totalFuel : 0
        break
      case 2: // total fuel ticks for the current fuel item
        w.totalFuel = value
        w.totalFuelSeconds = toSeconds(value)
        if (w._litTime != null) w.fuel = value ? w._litTime / value : 0
        break
    }
    if (typeof w.emit === 'function') w.emit('update')
  })

  // Smelt with a furnace, blast furnace or smoker block: open it, load fuel + input, wait for the output, and take it. Resolves with the output
  // item. count is how many to smelt (one fuel item covers several smelts; add more fuel by calling putFuel).
  bot.smelt = async (furnaceBlock, inputName, fuelName, count = 1) => {
    if (typeof bot.openContainer !== 'function') throw new Error('smelt: needs the containers plugin')
    if (!bot.currentWindow || (furnaceBlock && !isFurnaceWindow(bot.currentWindow))) { bot.openContainer(furnaceBlock); await waitForFurnace() }
    await bot.putFuel(fuelName, Math.max(1, Math.ceil(count / 8)))
    await bot.putSmeltable(inputName, count)
    // Wait for furnace_output (window slot 2) to hold the smelted items.
    const output = await waitForOutput(count, 15000 + count * 11000)
    if (!output) throw new Error('smelt: timed out waiting for the furnace output')
    const dest = firstFreeBedrockSlot()
    if (dest == null) throw new Error('smelt: no free inventory slot for the output')
    const id = nextStackId()
    const actions = [{ type_id: 'take', legacy_type_id: 0, count: output.count, source: { slot_type: { container_id: 'furnace_output' }, slot: 2, stack_id: output.stackId ?? id }, destination: { slot_type: { container_id: invContainer(dest) }, slot: dest, stack_id: 0 } }]
    const response = await new Promise((resolve) => { pending.set(id, resolve); send('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [], cause: -1 }] }) })
    if (response.status !== 'ok') throw new Error(`smelt: taking the output was rejected (status ${response.status})`)
    const Item = require('prismarine-item')(bot.registry)
    const result = new Item(output.type, output.count, output.metadata ?? 0)
    bot.inventory.updateSlot(playerSlot(dest), result)
    return result
  }

  function waitForFurnace () {
    return new Promise((resolve) => {
      if (isFurnaceWindow(bot.currentWindow)) return resolve(bot.currentWindow)
      const timer = setTimeout(() => { bot.removeListener('windowOpen', onOpen); resolve(bot.currentWindow) }, 3000)
      function onOpen (w) { clearTimeout(timer); resolve(w) }
      bot.once('windowOpen', onOpen)
    })
  }
  function waitForOutput (count, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now()
      const timer = setInterval(() => {
        const out = bot.currentWindow && bot.currentWindow.slots && bot.currentWindow.slots[2]
        if (out && out.count >= count) { clearInterval(timer); resolve(out) } else if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve(bot.currentWindow && bot.currentWindow.slots && bot.currentWindow.slots[2]) }
      }, 500)
    })
  }
}
