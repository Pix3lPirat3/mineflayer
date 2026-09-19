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
}
