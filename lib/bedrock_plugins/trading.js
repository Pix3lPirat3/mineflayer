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

  // Execute a trade. `trade` is an entry of bot.trades (or its index). Verified against a real-client capture (1.26.51):
  // place the input(s) into the trade2_ingredient1/2 container, then one item_stack_request that runs the trade
  // (craft_recipe with the trade's recipe_network_id = trade.netId), consumes the ingredient, and takes the output from
  // creative_output slot 50 into a free inventory slot. Repeats `times`. Needs the trade window open (bot.useOn the trader
  // first, await 'tradeListReady').
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  bot.trade = async (trade, times = 1) => {
    if (!bot._stack) throw new Error('trade: stack_request plugin not loaded')
    if (typeof trade === 'number') trade = (bot.trades || [])[trade]
    if (!trade || trade.netId == null) throw new Error('trade: pass a bot.trades entry (with a netId) - open the trader first')
    if (!bot.tradeWindow) throw new Error('trade: no trade window open (bot.useOn the villager/trader first)')
    const { stackReq, stackIdFor, applyStackIds, bedrockOf, invContainer, firstFreeBedrockSlot } = bot._stack
    const Item = require('prismarine-item')(bot.registry)

    const findInv = (want) => {
      if (!want) return null
      return bot.inventory.items().find(i => i.type === want.type || i.name === want.name)
    }
    for (let n = 0; n < times; n++) {
      if (trade.tradeDisabled) throw new Error('trade: this trade is disabled (out of stock)')
      // Place ingredient 1 (required) and ingredient 2 (optional) into the trade slots.
      const placeInput = async (want, containerId) => {
        if (!want) return null
        const src = findInv(want)
        if (!src) throw new Error(`trade: missing input ${want.name} in inventory`)
        const fromBedrock = bedrockOf(src.slot)
        const { response, status } = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: want.count, source: { slot_type: { container_id: invContainer(fromBedrock) }, slot: fromBedrock, stack_id: src.stackId ?? 0 }, destination: { slot_type: { container_id: containerId }, slot: 4, stack_id: 0 } }])
        if (status !== 'ok') throw new Error(`trade: could not place ${want.name} (status ${status})`)
        // Reduce the player-side source stack by the amount we moved.
        const p = bot.inventory.slots[src.slot]; if (p) { p.count -= want.count; if (p.count <= 0) bot.inventory.updateSlot(src.slot, null) }
        return { containerId, slot: 4, stackId: stackIdFor(response, containerId, 4) }
      }
      const in1 = await placeInput(trade.inputItem1, 'trade2_ingredient1')
      const in2 = await placeInput(trade.inputItem2, 'trade2_ingredient2')
      await wait(120)

      const dest = firstFreeBedrockSlot()
      if (dest == null) throw new Error('trade: no free inventory slot for the output')
      const out = trade.outputItem
      const outName = out.name.startsWith('minecraft:') ? out.name : 'minecraft:' + out.name
      const actions = [
        { type_id: 'craft_recipe', legacy_type_id: 12, recipe_network_id: trade.netId, times_crafted: 1 },
        // results_deprecated carries the expected result descriptor (verified against a real-client trade capture).
        { type_id: 'results_deprecated', legacy_type_id: 19, times_crafted: 1, result_items: [{ type: 'name', legacy_type: 1, name: outName, metadata: out.metadata ?? 0, count: out.count, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } }] },
        { type_id: 'consume', legacy_type_id: 5, count: trade.inputItem1.count, source: { slot_type: { container_id: in1.containerId }, slot: in1.slot, stack_id: in1.stackId } }
      ]
      if (in2) actions.push({ type_id: 'consume', legacy_type_id: 5, count: trade.inputItem2.count, source: { slot_type: { container_id: in2.containerId }, slot: in2.slot, stack_id: in2.stackId } })
      const { id, response, status } = await stackReq((rid) => {
        actions.push({ type_id: 'take', legacy_type_id: 0, count: out.count, source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: rid }, destination: { slot_type: { container_id: invContainer(dest) }, slot: dest, stack_id: 0 } })
        return actions
      })
      void id
      if (status !== 'ok') throw new Error(`trade: the trade was rejected (status ${status})`)
      // Mirror the output into the inventory and take authoritative stack ids from the response.
      bot.inventory.updateSlot((dest < 9 ? 36 + dest : dest), new Item(out.type ?? out.id, out.count, out.metadata ?? 0))
      applyStackIds(response)
      await wait(150)
    }
  }
}
