module.exports = inject

// Villager / wandering-trader trades on Bedrock. Interacting with a trader (bot.useOn) makes the server send an
// update_trade packet whose `offers` NBT holds the recipe list. Parse it into bot.trades (the same read surface the
// Java villager plugin exposes: inputItem1/inputItem2/outputItem + use counts) and fire 'tradeListReady'. Verified live
// on BDS 1.26.45 against a wandering_trader. Executing a trade (moving items through the trade window) is a follow-up.
function inject (bot) {
  bot.trades = null

  bot._client.on('update_trade', packet => {
    const Item = require('prismarine-item')(bot.registry)

    // A Bedrock item NBT compound -> prismarine-item (or null). Damage 32767 is the "any"/wildcard sentinel.
    const toItem = (nbtItem, countOverride) => {
      const v = nbtItem && nbtItem.value
      if (!v || !v.Name) return null
      const name = String(v.Name.value || '').replace(/^minecraft:/, '')
      const info = bot.registry.itemsByName?.[name]
      if (!info) return null
      const meta = v.Damage?.value
      const count = countOverride ?? v.Count?.value ?? 1
      return new Item(info.id, count, meta === 32767 || meta == null ? 0 : meta)
    }

    const recipesNbt = packet.offers?.value?.Recipes?.value
    const recipes = Array.isArray(recipesNbt?.value) ? recipesNbt.value : (Array.isArray(recipesNbt) ? recipesNbt : [])
    bot.trades = recipes.map(r => {
      const buyCountA = r.buyCountA?.value
      const buyCountB = r.buyCountB?.value
      const maxUses = r.maxUses?.value ?? 0
      const uses = r.uses?.value ?? 0
      return {
        inputItem1: toItem(r.buyA, buyCountA),
        inputItem2: buyCountB ? toItem(r.buyB, buyCountB) : null,
        outputItem: toItem(r.sell),
        maxNbTradeUses: maxUses,
        nbTradeUses: uses,
        tradeDisabled: uses >= maxUses,
        rewardExp: !!(r.rewardExp?.value),
        tier: r.tier?.value ?? 0,
        netId: r.netId?.value
      }
    }).filter(t => t.outputItem)

    bot.tradeWindow = {
      id: packet.window_id,
      type: packet.window_type,
      villagerEntityId: Number(packet.villager_unique_id),
      title: packet.display_name,
      trades: bot.trades
    }
    bot.emit('tradeListReady', bot.trades, bot.tradeWindow)
  })
}
