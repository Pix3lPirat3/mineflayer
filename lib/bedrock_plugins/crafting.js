module.exports = inject

// Recipe book. The server sends every recipe in a crafting_data packet at login, split by type (shaped_recipes,
// shapeless_recipes, ...), each carrying its ingredients, its output (by item network id) and a recipe network id that
// the craft action references. This plugin parses the shaped and shapeless recipes into a queryable index and exposes
// bot.recipesFor / bot.recipesAll, matching the Java plugin's read surface. Executing a craft (placing ingredients in
// the grid and sending the item_stack_request) is a separate, server-authoritative step verified live; it is not done
// here. Packet shape verified against a real-client relay capture.
function inject (bot) {
  bot.craftingRecipes = []
  const byResult = new Map() // canonical item id -> recipe[]

  const resultItem = (output) => {
    const first = (output || []).find(o => o && o.network_id)
    if (!first) return null
    if (typeof bot._bedrockItemFromNotch === 'function') return bot._bedrockItemFromNotch(first)
    return { networkId: first.network_id, count: first.count }
  }

  const ingredient = (entry) => {
    if (!entry || entry.type === 'invalid' || entry.descriptor_type == null) return null
    if (entry.descriptor_type === 'item_tag') return { tag: entry.tag, count: entry.count ?? 1 }
    const name = typeof entry.name === 'string' ? entry.name.replace(/^minecraft:/, '') : entry.name
    const id = bot.registry?.itemsByName?.[name]?.id
    return { name, id, count: entry.count ?? 1 }
  }

  const parse = (raw, type) => {
    const result = resultItem(raw.output)
    if (!result) return null
    const ingredients = (raw.input || []).map(ingredient).filter(Boolean)
    if (!ingredients.length) return null
    const width = raw.width
    const height = raw.height
    // A 2x2 grid (the player inventory) can only make recipes up to 2x2 / 4 loose ingredients; larger needs a table.
    const requiresTable = type === 'shaped' ? (width > 2 || height > 2) : ingredients.length > 4
    return { id: raw.network_id, recipeId: raw.recipe_id, type, width, height, result, ingredients, requiresTable }
  }

  bot._client.on('crafting_data', (packet) => {
    const recipes = []
    for (const raw of packet.shaped_recipes || []) { const r = parse(raw, 'shaped'); if (r) recipes.push(r) }
    for (const raw of packet.shapeless_recipes || []) { const r = parse(raw, 'shapeless'); if (r) recipes.push(r) }
    bot.craftingRecipes = recipes
    byResult.clear()
    for (const r of recipes) {
      const key = r.result.type ?? r.result.id ?? r.result.networkId
      if (key == null) continue
      if (!byResult.has(key)) byResult.set(key, [])
      byResult.get(key).push(r)
    }
    bot.emit('craftingRecipesReady', recipes.length)
  })

  // Recipes producing itemType (a numeric item id or an item name). craftingTable=false keeps only 2x2 recipes. Mirrors
  // the Java plugin's shape closely enough for callers that select a recipe to then craft.
  bot.recipesFor = (itemType, metadata = null, minResultCount = 1, craftingTable = false) => {
    let id = itemType
    if (typeof itemType === 'string') id = bot.registry?.itemsByName?.[itemType.replace(/^minecraft:/, '')]?.id
    const list = byResult.get(id) || []
    return list.filter(r => (craftingTable || !r.requiresTable) && (r.result.count ?? 1) >= minResultCount)
  }

  bot.recipesAll = (itemType, metadata = null, craftingTable = true) => bot.recipesFor(itemType, metadata, 1, craftingTable)

  // Craft `count` batches of a recipe. Verified server-authoritative flow (BDS 1.26.45): with the inventory (2x2) or a
  // crafting-table screen open, place each ingredient into the crafting_input grid, then one item_stack_request that
  // begins the craft (craft_recipe), consumes the grid, and takes the result out of the output slot - container
  // 'creative_output' slot 50, whose stack id is the request id - into a free inventory slot. Player hotbar/inventory
  // use absolute Bedrock slots 0-35; the 2x2 grid is crafting_input slots 28-31 (row-major). Only 2x2 recipes with name
  // ingredients are supported here; 3x3 (a real crafting table) and item-tag ingredients are a follow-up.
  let craftRequestId = -1
  const QUICK_BAR_START = 36
  const playerSlot = (bedrockSlot) => bedrockSlot < 9 ? QUICK_BAR_START + bedrockSlot : bedrockSlot
  const bedrockOf = (playerIndex) => playerIndex >= QUICK_BAR_START ? playerIndex - QUICK_BAR_START : playerIndex
  const invContainer = (bedrockSlot) => bedrockSlot < 9 ? 'hotbar' : 'inventory'
  const send = (name, packet) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, packet); else bot._client.write(name, packet) }
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

  // Every craft/place request resolves with its own item_stack_response (status + containers).
  const pendingCraft = new Map()
  bot._client.on('item_stack_response', (packet) => {
    for (const response of packet.responses || []) {
      const p = pendingCraft.get(response.request_id)
      if (!p) continue
      pendingCraft.delete(response.request_id)
      p(response)
    }
  })
  const sendRequest = (actions) => {
    craftRequestId -= 2
    const id = craftRequestId
    return new Promise((resolve) => { pendingCraft.set(id, resolve); send('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [], cause: -1 }] }) }).then(response => ({ id, response, status: response.status }))
  }
  const gridStackFromResponse = (response, slot) => {
    for (const c of response.containers || []) {
      if (c.slot_type?.container_id !== 'crafting_input') continue
      const s = (c.slots || []).find(x => x.slot === slot)
      if (s && s.item_stack_id != null) return s.item_stack_id
    }
    return 0
  }
  const findIngredient = (ing) => {
    const items = bot.inventory?.items?.() || []
    if (ing.name) return items.find(i => i.name === ing.name)
    if (ing.tag) { const base = ing.tag.replace(/^minecraft:/, '').replace(/s$/, ''); return items.find(i => i.name && i.name.includes(base)) }
    return null
  }
  const firstFreeBedrockSlot = () => {
    for (let s = 0; s < 36; s++) if (!bot.inventory.slots[playerSlot(s)]) return s
    return null
  }

  bot.craft = async (recipe, count = 1, craftingTable = null) => {
    if (!recipe || recipe.id == null) throw new Error('craft: a recipe (from bot.recipesFor) is required')
    if (recipe.requiresTable && !craftingTable) throw new Error('craft: this recipe needs a crafting table')
    if (typeof bot.openInventory === 'function' && !bot.currentWindow && !craftingTable) { bot.openInventory(); await wait(600) }
    const Item = require('prismarine-item')(bot.registry)
    for (let batch = 0; batch < count; batch++) {
      // Place one of each ingredient into the 2x2 grid (row-major from slot 28); keep the server stack id per grid slot.
      const gridSlots = []
      for (let i = 0; i < recipe.ingredients.length; i++) {
        const item = findIngredient(recipe.ingredients[i])
        if (!item) throw new Error(`craft: missing ingredient ${recipe.ingredients[i].name || recipe.ingredients[i].tag}`)
        const fromBedrock = bedrockOf(item.slot)
        const gridSlot = 28 + i
        const { response, status } = await sendRequest([{ type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: { container_id: invContainer(fromBedrock) }, slot: fromBedrock, stack_id: item.stackId ?? 0 }, destination: { slot_type: { container_id: 'crafting_input' }, slot: gridSlot, stack_id: 0 } }])
        if (status !== 'ok') throw new Error(`craft: could not place an ingredient into the grid (status ${status})`)
        gridSlots.push({ slot: gridSlot, stackId: gridStackFromResponse(response, gridSlot) })
        const p = playerSlot(fromBedrock)
        const inv = bot.inventory.slots[p]
        if (inv) { inv.count -= 1; if (inv.count <= 0) bot.inventory.updateSlot(p, null) }
        await wait(120)
      }
      // Begin the craft, consume the grid, and take the result to a free slot (the output stack id is the request id).
      const dest = firstFreeBedrockSlot()
      if (dest == null) throw new Error('craft: no free inventory slot for the result')
      craftRequestId -= 2
      const id = craftRequestId
      const actions = [{ type_id: 'craft_recipe', legacy_type_id: 12, recipe_network_id: recipe.id, times_crafted: 1 }]
      for (const g of gridSlots) actions.push({ type_id: 'consume', legacy_type_id: 5, count: 1, source: { slot_type: { container_id: 'crafting_input' }, slot: g.slot, stack_id: g.stackId } })
      actions.push({ type_id: 'take', legacy_type_id: 0, count: recipe.result.count, source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: id }, destination: { slot_type: { container_id: invContainer(dest) }, slot: dest, stack_id: 0 } })
      const response = await new Promise((resolve) => { pendingCraft.set(id, resolve); send('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [], cause: -1 }] }) })
      if (response.status !== 'ok') throw new Error(`craft: the craft was rejected (status ${response.status})`)
      // Mirror the crafted result into bot.inventory (the server placed it in `dest`).
      bot.inventory.updateSlot(playerSlot(dest), new Item(recipe.result.type ?? recipe.result.id, recipe.result.count, recipe.result.metadata ?? 0))
      await wait(150)
    }
  }
}
