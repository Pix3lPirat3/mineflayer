module.exports = inject

// Furnace smelting. Verified server-authoritative flow (BDS 1.26.45): open the furnace (container_open, window type
// 'furnace'), place the smeltable into furnace_ingredient slot 0 and the fuel into furnace_fuel slot 1 with
// item_stack_request 'place'; the server smelts over time (progress arrives as container_set_data -> containerProperty)
// and fills furnace_output slot 2, which is taken out with 'take'. The furnace slot numbers match the window layout
// (ingredient 0, fuel 1, output 2), each addressed with its own container id. bot.smelt drives the whole cycle.
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

  // Put a smeltable / fuel into an already-open furnace (bot.currentWindow must be a furnace).
  bot.putSmeltable = async (itemName, count = 1) => { const it = findItem(itemName); if (!it) throw new Error(`furnace: no ${itemName} to smelt`); return placeInto(it, 'furnace_ingredient', 0, count) }
  bot.putFuel = async (itemName, count = 1) => { const it = findItem(itemName); if (!it) throw new Error(`furnace: no ${itemName} for fuel`); return placeInto(it, 'furnace_fuel', 1, count) }

  // Java-parity furnace progress fields on the open window (bot.currentWindow.fuel/fuelSeconds/progress/... like
  // mineflayer-java's Furnace), fed by container_set_data. Bedrock's property indices differ from Java and are
  // verified live (BDS 1.26.45): 0 = smelt tick count (counts UP 0..200 per item) -> Java "current progress"; 1 = lit
  // time remaining (counts DOWN) -> Java "current fuel"; 2 = lit duration (total ticks for the current fuel) -> Java
  // "total fuel"; 3 = stored XP. Bedrock sends no "total progress"; a normal furnace smelts in 200 ticks (10s).
  const TOTAL_SMELT_TICKS = 200
  const toSeconds = t => (t == null ? null : t / 20)
  bot.on('windowOpen', (w) => {
    if (!w || w.type !== 'furnace') return
    w.totalFuel = w.fuel = w.fuelSeconds = w.totalFuelSeconds = null
    w.totalProgress = w.progress = w.progressSeconds = w.totalProgressSeconds = null
    w._litTime = null
    if (!w.inputItem) { w.inputItem = () => w.slots[0]; w.fuelItem = () => w.slots[1]; w.outputItem = () => w.slots[2] }
  })
  bot.on('containerProperty', (wid, prop, value) => {
    const w = bot.currentWindow
    if (!w || w.id !== wid || w.type !== 'furnace') return
    switch (prop) {
      case 0: // smelt progress, counts up toward 200
        w.totalProgress = TOTAL_SMELT_TICKS
        w.totalProgressSeconds = toSeconds(TOTAL_SMELT_TICKS)
        w.progress = value / TOTAL_SMELT_TICKS
        w.progressSeconds = toSeconds(TOTAL_SMELT_TICKS - value)
        break
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

  // Smelt with a furnace block: open it, load fuel + input, wait for the output, and take it. Resolves with the output
  // item. count is how many to smelt (one fuel item covers several smelts; add more fuel by calling putFuel).
  bot.smelt = async (furnaceBlock, inputName, fuelName, count = 1) => {
    if (typeof bot.openContainer !== 'function') throw new Error('smelt: needs the containers plugin')
    if (!bot.currentWindow || (furnaceBlock && bot.currentWindow.type !== 'furnace')) { bot.openContainer(furnaceBlock); await waitForFurnace() }
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
      if (bot.currentWindow && bot.currentWindow.type === 'furnace') return resolve(bot.currentWindow)
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
